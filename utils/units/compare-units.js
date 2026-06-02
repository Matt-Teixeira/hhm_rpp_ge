const {
   type: { I, W, E },
   tag: { cal, det, cat, seq, qaf },
} = require('../logger/enums');
const [addLogEvent] = require('../logger/log');

const compareUnits = async (run_log, note, units_1, units_2) => {
   // CREATE A NOTE PLACEHOLDER OBJECT IN CASE THE CALLING APPLICATION DOESN'T PROVIDE ONE
   if (!note) {
      note = {};
   }
   // STANDARD NOTE ADDITIONS
   note['units_1'] = units_1;
   note['units_2'] = units_2;

   let units_matched;
   if (units_1 === units_2) {
      units_matched = true;
   } else {
      units_matched = false;
   }
   note['units_matched'] = units_matched;
   addLogEvent(I, run_log, 'compareUnits', det, note, null);

   return units_matched;
};

module.exports = compareUnits;
