// const axios = require('axios');
// const https = require('https');
// const {
//    type: { I, W, E },
//    tag: { cal, det, cat, seq, qaf },
// } = require('../logger/enums');
// const [addLogEvent] = require('../logger/log');

// const getTunnelsByIP = async (run_log, ip_addresses) => {
//    try {
//       const url = `https://${process.env.VNS3_IP}:8000/api/status/ipsec`;
//       const agent = new https.Agent({
//          rejectUnauthorized: false,
//       });
//       const pw = process.env.VNS3_PW;
//       const options = {
//          httpsAgent: agent,
//          headers: {
//             Accept: 'application/json',
//             Authorization:
//                'Basic ' + Buffer.from('api:' + pw).toString('base64'),
//          },
//       };

//       // GET THE IPSEC STATUS PAYLOAD WHICH CONTAINS, AMONG OTHER THINGS:
//       // endpoint_id AND tunnel_id NEEDED FOR TUNNEL BOUNCE (RESET)
//       const res = await axios.get(url, options);
//       const ipsec_status = res?.data;

//       let note = { ipsec_status: ipsec_status };
//       addLogEvent(I, run_log, 'getTunnelsByIP', det, note, null);

//       // REFORMAT FOR EASIER FILTERING
//       const tunnels = Object.entries(ipsec_status.response).map(
//          ([id, ip_status]) => ({ id, ip_status })
//       );

//       const tunnel_resets = [];
//       for (const ip of ip_addresses) {
//          // SHOULD BE ONLY 1 MATCH AS remote_subnet SHOULD BE UNIQUE
//          const [tunnel] = tunnels.filter(({ ip_status }) =>
//             ip_status.remote_subnet.includes(ip)
//          );

//          if (!tunnel) {
//             note = {
//                ip: ip,
//                txt: 'NO TUNNEL FOUND',
//             };
//             addLogEvent(W, run_log, 'getTunnelsByIP', qaf, note, null);
//             continue;
//          }

//          const { id, ip_status } = tunnel;

//          const reset_info = {
//             ip: ip,
//             endpoint_id: ip_status.endpointid,
//             tunnel_id: parseInt(id),
//          };

//          tunnel_resets.push(reset_info);
//       }

//       const redundant_tunnel_resets = [];
//       const unique_key_map = {};
//       const unique_tunnel_resets = tunnel_resets.filter((reset) => {
//          const composite_key = reset.endpoint_id + '-' + reset.tunnel_id;
//          if (!unique_key_map[composite_key]) {
//             unique_key_map[composite_key] = true;
//             return true;
//          }
//          redundant_tunnel_resets.push(reset);
//          return false;
//       });

//       note = {
//          redundant_tunnel_resets: redundant_tunnel_resets,
//          unique_tunnel_resets: unique_tunnel_resets,
//       };
//       addLogEvent(I, run_log, 'getTunnelsByIP', det, note, null);

//       return unique_tunnel_resets;
//    } catch (error) {
//       addLogEvent(E, run_log, 'getTunnelsByIP', cat, null, error);
//       return null;
//    }
// };

// module.exports = getTunnelsByIP;
