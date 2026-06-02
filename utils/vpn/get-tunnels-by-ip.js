const {
   type: { I, W, E },
   tag: { cal, det, cat, seq, qaf },
} = require('../logger/enums');
const [addLogEvent] = require('../logger/log');
const db = require('../../utils/db/pg-pool');

const getTunnelsByIP = async (run_log, ip_addresses) => {
   try {
      const pq = `
      SELECT 	* 
      FROM 	   util.ip_sec
      WHERE 	remote_subnet_ip 
      IN 		($1:list)
      ORDER BY remote_subnet_ip`;

      const args = [ip_addresses];
      const tunnels = await db.any(pq, args);

      let note = { tunnels: tunnels };
      addLogEvent(I, run_log, 'getTunnelsByIP', det, note, null);

      const tunnel_resets = [];
      for (const ip of ip_addresses) {
         // SHOULD BE ONLY 1 MATCH AS remote_subnet SHOULD BE UNIQUE
         const [tunnel] = tunnels.filter(
            ({ remote_subnet_ip }) => remote_subnet_ip === ip
         );

         if (!tunnel) {
            note = {
               ip: ip,
               txt: 'NO TUNNEL FOUND',
            };
            addLogEvent(W, run_log, 'getTunnelsByIP', qaf, note, null);
            continue;
         }

         const reset_info = {
            ip: tunnel.remote_subnet_ip,
            endpoint_id: tunnel.endpoint_id,
            tunnel_id: tunnel.tunnel_id,
         };

         tunnel_resets.push(reset_info);
      }

      const redundant_tunnel_resets = [];
      const unique_key_map = {};
      const unique_tunnel_resets = tunnel_resets.filter((reset) => {
         const composite_key = reset.endpoint_id + '-' + reset.tunnel_id;
         if (!unique_key_map[composite_key]) {
            unique_key_map[composite_key] = true;
            return true;
         }
         redundant_tunnel_resets.push(reset);
         return false;
      });

      note = {
         redundant_tunnel_resets: redundant_tunnel_resets,
         unique_tunnel_resets: unique_tunnel_resets,
      };
      addLogEvent(I, run_log, 'getTunnelsByIP', det, note, null);

      return unique_tunnel_resets;
   } catch (error) {
      addLogEvent(E, run_log, 'getTunnelsByIP', cat, null, error);
      return null;
   }
};

module.exports = getTunnelsByIP;
