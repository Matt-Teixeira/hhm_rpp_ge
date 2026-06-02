const axios = require('axios');
const https = require('https');
const {
   type: { I, W, E },
   tag: { cal, det, cat, seq, qaf },
} = require('../logger/enums');
const [addLogEvent] = require('../logger/log');

const resetTunnels = async (run_log, tunnels) => {
   for (const tunnel of tunnels) {
      let note = { tunnel: tunnel };
      // addLogEvent(I, run_log, 'resetTunnels', cal, note, null);

      try {
         const { ip, endpoint_id, tunnel_id } = tunnel;

         const url = `https://${process.env.VNS3_IP}:8000/api/ipsec/endpoints/${endpoint_id}/tunnels/${tunnel_id}`;
         const body = { bounce: true };
         const agent = new https.Agent({
            rejectUnauthorized: false,
         });
         const pw = process.env.VNS3_PW;
         const options = {
            httpsAgent: agent,
            headers: {
               Accept: 'application/json',
               Authorization:
                  'Basic ' + Buffer.from('api:' + pw).toString('base64'),
            },
         };

         // RESET TUNNEL
         const res = await axios.put(url, body, options);
         const bounce_res = res?.data;

         note['txt'] = 'TUNNEL RESET SUCCESSFUL';
         note['bounce_res'] = bounce_res;
         addLogEvent(I, run_log, 'resetTunnels', det, note, null);
      } catch (error) {
         note['txt'] = 'TUNNEL RESET FAILED';
         addLogEvent(E, run_log, 'resetTunnels', cat, note, error);
         continue;
      }
   }
};

module.exports = resetTunnels;
