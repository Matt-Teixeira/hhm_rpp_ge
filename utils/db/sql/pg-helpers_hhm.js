const pgp = require("pg-promise")();

//const { pg_column_sets: pg_cs } = require('./utils/db/sql/pg-helpers');
//query = pgp.helpers.insert(rows, pg_cs.mag.ge.mm3);

// HELPER FOR LINKING TO EXTERNAL QUERY FILES

const pg_tables = {
  alert: {
    ip: {
      offline: new pgp.helpers.TableName({
        table: "offline",
        schema: "alert"
      })
    }
  },
  ge: {
    ge_ct_gesys: new pgp.helpers.TableName({
      table: "ge_ct_gesys",
      schema: "log"
    }),
    ge_cv_syserror: new pgp.helpers.TableName({
      table: "ge_cv_syserror",
      schema: "log"
    }),
    ge_mri_gesys: new pgp.helpers.TableName({
      table: "ge_mri_gesys",
      schema: "log"
    })
  },
  philips: {
    logcurrent: new pgp.helpers.TableName({
      table: "philips_mri_logcurrent",
      schema: "log"
    }),
    stt_magnet: new pgp.helpers.TableName({
      table: "stt_magnet",
      schema: "log"
    }),
    mag_stt_magnet: new pgp.helpers.TableName({
      table: "stt_magnet",
      schema: "mag"
    }),
    rmmu_short: new pgp.helpers.TableName({
      table: "philips_mri_rmmu_short",
      schema: "mag"
    }),
    rmmu_long: new pgp.helpers.TableName({
      table: "philips_mri_rmmu_long",
      schema: "mag"
    }),
    rmmu_magnet: new pgp.helpers.TableName({
      table: "philips_mri_rmmu_magnet",
      schema: "mag"
    }),
    rmmu_history: new pgp.helpers.TableName({
      table: "philips_mri_rmmu_history",
      schema: "mag"
    }),
    philips_ct_eal: new pgp.helpers.TableName({
      table: "philips_ct_eal",
      schema: "log"
    }),
    philips_ct_events: new pgp.helpers.TableName({
      table: "philips_ct_events",
      schema: "log"
    }),
    philips_ct_eal_events: new pgp.helpers.TableName({
      table: "philips_ct_eal_events",
      schema: "log"
    }),
    philips_cv_eventlog: new pgp.helpers.TableName({
      table: "philips_cv_eventlog",
      schema: "log"
    })
  },
  meta_data: {
    logfile_event_history_metadata: new pgp.helpers.TableName({
      table: "logfile_event_history_metadata",
      schema: "public"
    })
  },
  siemens: {
    siemens_ct: new pgp.helpers.TableName({
      table: "siemens_ct",
      schema: "log"
    }),
    siemens_cv: new pgp.helpers.TableName({
      table: "siemens_cv",
      schema: "log"
    }),
    siemens_mri: new pgp.helpers.TableName({
      table: "siemens_mri",
      schema: "log"
    })
  }
};

const pg_column_sets = {
  alert: {
    ip: {
      offline: new pgp.helpers.ColumnSet(["system_id", "capture_datetime"], {
        table: pg_tables.alert.ip.offline
      })
    }
  },
  log: {
    ge: {
      ge_ct_gesys: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "epoch",
          "record_number_concurrent",
          "misc_param_1",
          "month",
          "day",
          "host_date",
          "host_time",
          "year",
          "message_number",
          "misc_param_2",
          "type",
          "data_1",
          "num_1",
          "date_2",
          "host",
          "ermes_number",
          "exception_class",
          "severity",
          "file",
          "line_number",
          "scan_type",
          "warning",
          "end_msg",
          "message",
          "sr",
          "en",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.ge.ge_ct_gesys }
      ),
      ge_cv_syserror: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "sequencenumber",
          "host_date",
          "host_time",
          "subsystem",
          "errorcode",
          "errortext",
          "exam",
          "exceptioncategory",
          "application",
          "majorfunction",
          "minorfunction",
          "fru",
          "viewinglevel",
          "rootcause",
          "repeatcount",
          "debugtext",
          "sourcefile",
          "sourceline",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.ge.ge_cv_syserror }
      ),
      ge_mri_gesys: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "epoch",
          "record_number_concurrent",
          "misc_param_1",
          "month",
          "day",
          "host_date",
          "host_time",
          "year",
          "message_number",
          "misc_param_2",
          "type",
          "data_1",
          "num_1",
          "server",
          "task_id",
          "task_epoc",
          "object",
          "exception_class",
          "severity",
          "function",
          "psd",
          "coil",
          "scan",
          "message",
          "sr",
          "en",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.ge.ge_mri_gesys }
      )
    },
    philips: {
      logcurrent: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "host_date",
          "host_time",
          "row_type",
          "event_type",
          "subsystem",
          "code_1",
          "code_2",
          "group_1",
          "message",
          "packets_created",
          "data_created_value",
          "size_copy_value",
          "data_8",
          "reconstructor",
          "magnet_meu",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.logcurrent }
      ),
      stt_magnet: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "host_date",
          "host_time",
          "header_1",
          "header_2",
          "category",
          "status_value",
          "test_result_2",
          "test_result",
          "message",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.stt_magnet }
      ),
      philips_ct_eal: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "host_date",
          "host_time",
          "controller",
          "data_type",
          "log_number",
          "tm_stamp",
          "err_type",
          "err_number",
          "vxw_err_no",
          "file",
          "line",
          "param_1",
          "param_2",
          "info",
          "eal_time",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.philips_ct_eal }
      ),
      philips_ct_events: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "type",
          "level",
          "module",
          "time_stamp",
          "host_date",
          "host_time",
          "message",
          "eal",
          "event_time",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.philips_ct_events }
      ),
      philips_ct_eal_events: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "host_date",
          "host_time",
          "controller",
          "data_type",
          "log_number",
          "tm_stamp",
          "err_type",
          "err_number",
          "vxw_err_no",
          "file",
          "line",
          "param_1",
          "param_2",
          "info",
          "eal_time",
          "type",
          "level",
          "module",
          "time_stamp",
          "message",
          "eal",
          "event_time",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.philips_ct_eal_events }
      ),
      philips_cv_eventlog: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "category",
          "host_date",
          "host_time",
          "error_type",
          "num_1",
          "technical_event_id",
          "description",
          "channel_id",
          "module",
          "source",
          "line",
          "memo",
          "subsystem_number",
          "thread_name",
          "message",
          "host_datetime",
          "capture_datetime",
          "lod"
        ],
        { table: pg_tables.philips.philips_cv_eventlog }
      )
    },
    siemens: {
      siemens_ct: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "host_state",
          "host_date",
          "host_time",
          "source_group",
          "type_group",
          "text_group",
          "domain_group",
          "id_group",
          "month",
          "day",
          "year",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.siemens.siemens_ct }
      ),
      siemens_cv: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "source",
          "domain",
          "type",
          "id_group",
          "dow",
          "month",
          "day",
          "year",
          "time",
          "text",
          "capture_datetime",
          "host_datetime"
        ],
        { table: pg_tables.siemens.siemens_cv }
      ),
      siemens_mri: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "host_state",
          "host_date",
          "host_time",
          "source_group",
          "type_group",
          "text_group",
          "domain_group",
          "id_group",
          "month",
          "day",
          "year",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.siemens.siemens_mri }
      )
    }
  },
  mag: {
    philips: {
      rmmu_short: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "system_reference_number",
          "hospital_name",
          "serial_number_magnet",
          "serial_number_meu",
          "lineno",
          "year",
          "mo",
          "dy",
          "hr",
          "mn",
          "ss",
          "hs",
          "avgpwr_value",
          "minpwr_value",
          "maxpwr_value",
          "avgabs_value",
          "avgprmbars_value",
          "minprmbars_value",
          "maxprmbars_value",
          "lhepct_value",
          "lhe2_value",
          "diffpressureswitch_state",
          "tempalarm_state",
          "pressurealarm_state",
          "cerr_state",
          "compressorreset_state",
          "chd_value",
          "cpr_value",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.rmmu_short }
      ),
      rmmu_long: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "system_reference_number",
          "hospital_name",
          "serial_number_magnet",
          "serial_number_meu",
          "lineno",
          "year",
          "mo",
          "dy",
          "hr",
          "mn",
          "ss",
          "hs",
          "dow_value",
          "avgpwr_value",
          "minpwr_value",
          "maxpwr_value",
          "avgabs_value",
          "avgprmbars_value",
          "minprmbars_value",
          "maxprmbars_value",
          "lhepct_value",
          "lhe2_value",
          "diffpressureswitch_state",
          "tempalarm_state",
          "pressurealarm_state",
          "cerr_state",
          "compressorreset_state",
          "chd_value",
          "cpr_value",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.rmmu_long }
      ),
      rmmu_magnet: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "system_reference_number",
          "hospital_name",
          "serial_number_magnet",
          "serial_number_meu",
          "lineno",
          "year",
          "mo",
          "dy",
          "hr",
          "mn",
          "ss",
          "hs",
          "event",
          "data",
          "descr",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.rmmu_magnet }
      ),
      rmmu_history: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "line",
          "time",
          "stat",
          "avgpwr",
          "minpwr",
          "maxpwr",
          "minpr",
          "maxpr",
          "lhe1",
          "lhe2",
          "dps",
          "talm",
          "palm",
          "cres",
          "system_reference_number",
          "hospital_name",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.rmmu_history }
      ),
      mag_stt_magnet: new pgp.helpers.ColumnSet(
        [
          "system_id",
          "field_name",
          "he_level_value",
          "he_pressure_value",
          "he_boil_off_value",
          "host_datetime",
          "capture_datetime"
        ],
        { table: pg_tables.philips.mag_stt_magnet }
      )
    }
  },
  meta_data: {
    logfile_event_history_metadata: new pgp.helpers.ColumnSet(
      ["system_id", "host_datetime", "name", "value"],
      { table: pg_tables.meta_data.logfile_event_history_metadata }
    )
  }
};

module.exports = { pg_tables, pg_column_sets };

/* 
  {
    system_id: 'SME01138',
    system_reference_number: '41481',
    hospital_name: 'Piedmont Newton Hospital',
    serial_number_magnet: 'WC_150_0458',
    serial_number_meu: 'BB4611',
    LineNo: '0001',
    year: '2023',
    mo: '07',
    dy: '18',
    hr: '07',
    mn: '59',
    ss: '36',
    hs: '70',
    AvgPwr_value: '0101',
    MinPwr_value: '0069',
    MaxPwr_value: '0135',
    AvgAbs_value: '09924',
    AvgPrMbars_value: '00305',
    MinPrMbars_value: '00297',
    MaxPrMbars_value: '00313',
    LHePct_value: '0663',
    LHe2_value: '0000',
    DiffPressureSwitch_state: 'Y',
    TempAlarm_state: 'N',
    PressureAlarm_state: 'N',
    Cerr_state: 'N',
    CompressorReset_state: 'N',
    Chd_value: '15',
    Cpr_value: '15',
    host_datetime: '2023-07-17T07:59:36.700-04:00'
  },
*/
