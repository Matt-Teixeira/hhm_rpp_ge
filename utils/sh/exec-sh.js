const {
   type: { I, W, E },
   tag: { cal, det, cat, seq, qaf },
} = require('../logger/enums');
const [addLogEvent] = require('../logger/log');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

const execSh = async (run_log, job_id, sh_path, sh_args) => {
   // THIS FUNCTION SYNCS A REMOTE FILE TO A LOCAL MIRROR AND RETURNS THE NEWLY SYNCED FILE SIZE

   let note = { job_id: job_id, sh_path: sh_path, sh_args: sh_args };
   addLogEvent(I, run_log, 'execSh', cal, note, null);

   try {
      // { stdout, stederr } = stream
      const stream = await execFile(sh_path, sh_args);

      note = {
         job_id: job_id,
         stream: stream,
      };
      addLogEvent(I, run_log, 'execSh', det, note, null);

      return stream;
   } catch (error) {
      addLogEvent(E, run_log, 'execSh', cat, { job_id: job_id }, error);
      return error;
   }
};

module.exports = execSh;
