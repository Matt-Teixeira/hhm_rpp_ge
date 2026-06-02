const buildParamQuery = require('./build-param-query');
const callParamQuery = require('./call-param-query');
const [addLogEvent] = require('../logger/log');
const {
   type: { E },
   tag: { cat },
} = require('../logger/enums');

const base_query =
   'SELECT systems.id AS sme FROM systems ' +
   'INNER JOIN sites ON systems.site_id = sites.id ' +
   'INNER JOIN customers ON sites.customer_id = customers.id ';

const processListConfig = async (run_log, job_id, email, list_config) => {
   try {
      // GENERATE THE USER SPECIFIC PQ FROM UEA SEED VALUES
      const param_query = await buildParamQuery(
         run_log,
         job_id,
         email,
         list_config,
         base_query
      );

      if (!param_query) {
         return;
      }

      // GET USER SPECIFIC DATA
      const data = await callParamQuery(run_log, job_id, param_query);
      // data = [{sme:"SME123"}, {sme:"SME456"}, etc]

      // EXTRACT ARRAY OF SME VALUES
      const sme_list = data.map(({ sme }) => sme);

      return sme_list;
   } catch (error) {
      addLogEvent(E, run_log, 'processListConfig', cat, null, error);
   }
};

module.exports = processListConfig;
