const db = require('../db/pg-pool');
const [addLogEvent] = require('../logger/log');
const {
   type: { I, W, E },
   tag: { cal, det, cat, seq, qaf },
} = require('../logger/enums');

const callParamQuery = async (run_log, job_id, param_query) => {
   try {
      const { query_text, query_args } = param_query;
      const data = await db.any(query_text, query_args);

      const note = { job_id: job_id, data: data };
      addLogEvent(I, run_log, 'callParamQuery', det, note, null);

      return data;
   } catch (error) {
      const note = { job_id: job_id };
      addLogEvent(E, run_log, 'callParamQuery', cat, note, error);
   }
};

module.exports = callParamQuery;
