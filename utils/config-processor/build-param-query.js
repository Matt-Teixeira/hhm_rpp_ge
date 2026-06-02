const [addLogEvent] = require('../logger/log');
const {
   type: { I, W, E },
   tag: { cal, det, cat, seq, qaf },
} = require('../logger/enums');

const buildParamQuery = async (
   run_log,
   job_id,
   email,
   list_config,
   base_query
) => {
   // systemListConfig RENAMED TO PLURAL list_config AS IT'S REALLY AN ARRAY OF CONFIGS -> [{},{}...]
   const note = {
      job_id: job_id,
      email: email,
      list_config: list_config,
   };
   addLogEvent(I, run_log, 'buildParamQuery', cal, note, null);

   try {
      // HOLDS REFERENCES TO EACH ARG PASSED TO THE QUERY EX. -> ["customers","id","C0051",...]
      const args_builder = [];
      // HOLDS THE DYNAMIC 'WHERE' CLAUSE APPNEDED TO THE BASE QUERY
      let query_builder = 'WHERE ';
      // COUNTER INJECTED INTO PARAM PLACEHOLDERS WITHIN query_builder
      // PARAMERTERIZED QUERY STARTS COUNTING AT 1, NOT 0
      let arg_index = 1;

      for (const sub_config of list_config) {
         // EACH sub_config{} FROM list_config[] REPRESENTS A POTENTIAL 'AND' CONDITION
         // WHILE EACH SIBLING sub_config IS SEPARATED BY AN 'OR' CONDITION
         // subconfig{} -> CAN BE NESTED OBJECT WHEREIN EACH OBJECT HAS BETWEEN 1 AND 2 K/V PAIRS
         // 1) K = table_column V = array OF MATCH VALUES
         // 2) *OPTIONAL K = "and" V = {} OF NESTED 'AND' CONDITION
         // SEE BOTTOM OF FILE FOR EXAMPLES

         // CLONE sub_config SO THE STRUCTURE CAN BE OVERWRITTEN WHILE BEING PROCESSED
         let config_clone = JSON.parse(JSON.stringify(sub_config));
         let has_nested_and;
         do {
            has_nested_and = false;

            // POPULATE args_builder WITH CONFIG KEY DATA
            // EX. ['systems_modality', 'and'?]
            const [table_column, and_indicator] = Object.keys(config_clone);
            const [table, column] = table_column.split('__');
            args_builder.push(table);
            args_builder.push(column);

            // POPULATE args_builder WITH CONFIG VALUE DATA
            // EX. [['MRI'], {nested_condition_object}?]
            const [table_column_value, nested_condition] =
               Object.values(config_clone);
            args_builder.push(table_column_value);

            // UPDATE WHERE CLAUSE WITH 'AND' SNIPPET
            query_builder +=
               '$' +
               arg_index++ +
               ':name.' +
               '$' +
               arg_index++ +
               ':name IN (' +
               '$' +
               arg_index++ +
               ':csv)';

            // CHECK FOR NESTED 'AND' CONDITION
            if (and_indicator) {
               has_nested_and = true;
               query_builder += ' AND ';
               config_clone = nested_condition;
            }
         } while (has_nested_and);

         // UPDATE WHERE CLAUSE WITH 'OR' SNIPPET
         query_builder += ' OR ';
      }

      // REMOVE TRAILING ' OR ', LEN=4, APPENDED DURING FINAL LOOP OF list_config
      query_builder = query_builder.slice(0, -4);

      // APPEND QUERY HEADER
      query_builder = base_query + query_builder;

      // APPEND QUERY TAIL
      query_builder = query_builder + ' ORDER BY systems.id';

      const pq = { query_text: query_builder, query_args: args_builder };

      const pq_note = {
         job_id: job_id,
         email: email,
         param_query: pq,
      };
      addLogEvent(I, run_log, 'buildParamQuery', det, pq_note, null);

      return pq;
   } catch (error) {
      const note = { job_id: job_id, email: email };
      addLogEvent(E, run_log, 'buildParamQuery', cat, note, error);
   }
};

module.exports = buildParamQuery;

// EX. SELECT * FROM systems WHERE manufacturer IN ('GE') AND modality IN ('MRI') AND model IN ('TWINSPEED HDXT');
// [
//    {
//       systems_manufacturer: ['GE'],
//       and: {
//          systems_modality: ['MRI'],
//          and: {
//             systems_model: ['TWINSPEED HDXT'],
//          },
//       },
//    },
// ];

// QUERY SNIPPET STRING EXAMPLE -> $1:name.$2:name IN ($3:csv)
// BUILT VIA:
// snippet +=
// '$' +
// arg_index++ +
// ':name.' +
// '$' +
// arg_index++ +
// ':name IN (' +
// '$' +
// arg_index++ +
// ':csv)';

// const manufacturer = 'GE';
// const modality = 'MRI';
// const model = 'TWIN';

// const andSeeds = [
//   {field_label: 'manufacturer', field_value: 'GE', pg_table: 'systems'},
//   {field_label: 'modality', field_value: 'MRI', pg_table: 'systems'},
//   {field_label: 'model', field_value: 'TWIN', pg_table: 'systems'}
// ];

// const preConfig = [];
// for (const seed of andSeeds) {
//   const {field_label, field_value, pg_table} = seed;
//   if (field_value) {
//   	const obj = {};
//     obj[`${pg_table}_${field_label}`] = [field_value];
//     preConfig.push(obj);
//   }
// }
// //console.log(preConfig);

// let andConfig = {};
// for (let i = preConfig.length - 1; i >= 0; i--) {
// 	let obj = preConfig[i];
//   	console.log(JSON.stringify(obj));
// 	if (i > 0) {
//     	let newObj = preConfig[i - 1];
//       	newObj['and'] = obj;
//       	andConfig = newObj;
//     }
// }
// console.log(andConfig);
