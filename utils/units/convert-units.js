const {
   type: { I, W, E },
   tag: { cal, det, cat, seq, qaf },
} = require('../logger/enums');
const [addLogEvent, writeLogEvents] = require('../logger/log');

const convertUnits = async (
   run_log,
   note,
   input_value,
   input_units,
   output_units,
   cond_args // ARRAY
) => {
   // CREATE A NOTE PLACEHOLDER OBJECT IN CASE THE CALLING APPLICATION DOESN'T PROVIDE ONE
   if (!note) {
      note = {};
   }

   // STANDARD NOTE ADDITIONS
   note['input_value'] = input_value;
   note['input_units'] = input_units;
   note['output_units'] = output_units;
   note['cond_args'] = cond_args;
   const composite_switch = input_units + '->' + output_units;
   note['composite_switch'] = composite_switch;

   let result;

   try {
      switch (composite_switch) {
         case 'LTRS->%':
            const [full_volume] = cond_args;
            result = (
               (parseFloat(input_value) / parseFloat(full_volume)) *
               100
            ).toFixed(2);
            result = Number(result);
            break;
         default:
            addLogEvent(W, run_log, 'convertUnits', qaf, note, null);
            return null;
      }

      note['result'] = result;
      addLogEvent(I, run_log, 'convertUnits', det, note, null);

      return result;
   } catch (error) {
      note['result'] = result;
      addLogEvent(E, run_log, 'convertUnits', cat, note, error);
      return null;
   }
};

module.exports = convertUnits;
