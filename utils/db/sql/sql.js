const { QueryFile } = require('pg-promise');
const { join: joinPath } = require('path');

// HELPER FOR LINKING TO EXTERNAL QUERY FILES
const sql = (file) => {
    const fullPath = joinPath(__dirname, file); // generating full path;
    return new QueryFile(fullPath, { minify: true });
};

module.exports = {
    alert_processor: {
        mmb: {
            get_data: sql('alert-processor/mmb/get-data.sql'),
            get_offline_data: {
                conn: sql('alert-processor/mmb/get-offline-conn-data.sql'),
            },
            get_philips_data: sql('alert-processor/mmb/get-philips-data.sql'),
            get_alert_models: {
                ge_mm3: sql('alert-processor/mmb/alert-models/ge-mm3.sql'),
                ge_mm4: sql('alert-processor/mmb/alert-models/ge-mm4.sql'),
                siemens: sql('alert-processor/mmb/alert-models/siemens.sql'),
                siemens_non_tim: sql(
                    'alert-processor/mmb/alert-models/siemens-non-tim.sql'
                ),
                philips: sql(
                    'alert-processor/mmb/alert-models/philips-monitoring.sql'
                ),
                edu_v2: sql('alert-processor/mmb/alert-models/edu-v2.sql'),
                offline_conn: sql(
                    'alert-processor/mmb/alert-models/offline-conn.sql'
                ),
                frozen_host: sql(
                    'alert-processor/mmb/alert-models/frozen-host.sql'
                ),
                absent_null_data: sql(
                    'alert-processor/mmb/alert-models/absent-null-data.sql'
                ),
            },
            get_alert_tests: {
                frozen_data: sql(
                    'alert-processor/mmb/alert-tests/frozen-data.sql'
                ),
                absent_null_data: sql(
                    'alert-processor/mmb/alert-tests/absent-null-data.sql'
                ),
            },
        },
        log: {
            get_data: sql('alert-processor/log/get-data.sql'),
            get_offline_data: {
                conn: sql('alert-processor/log/get-offline-conn-data.sql'),
            },
            get_alert_models: {
                philips_mri: sql(
                    'alert-processor/log/alert-models/philips-mri.sql'
                ),
                philips_ct_eal_events: sql(
                    'alert-processor/log/alert-models/philips-ct-eal-events.sql'
                ),
                philips_cv: sql(
                    'alert-processor/log/alert-models/philips-cv.sql'
                ),
                siemens_ct: sql(
                    'alert-processor/log/alert-models/siemens-ct.sql'
                ),
                offline_conn: sql(
                    'alert-processor/log/alert-models/offline-conn.sql'
                ),
                ge_ct_gesys: sql(
                    'alert-processor/log/alert-models/ge-ct-gesys.sql'
                ),
            },
        },
    },
    alert_notify: {
        get_users: sql('alert-notify/get-users.sql'),
        get_alert_detections: sql('alert-notify/get-alert-detections.sql'),
        get_systems_metadata: sql('alert-notify/get-systems-metadata.sql'),
        update_notification_email: sql(
            'alert-notify/update-notification-email.sql'
        ),
        update_notification_sms: sql(
            'alert-notify/update-notification-sms.sql'
        ),
        get_user_report_schemas: sql(
            'alert-notify/get-user-report-schemas.sql'
        ),
        get_he_level_report_data: sql(
            'alert-notify/get-he-level-report-data.sql'
        ),
        get_he_level_all_report: sql(
            'alert-notify/get-he-level-all-report.sql'
        ),
        get_he_psi_rport_data: sql('alert-notify/get-he-psi-report-data.sql'),
        get_he_psi_all_report: sql('alert-notify/get-he-psi-all-report.sql'),
        get_72_hr_pressure_report: sql(
            'alert-notify/he-pressure-72-hr-report.sql'
        ),
        get_default_alert_report: sql(
            'alert-notify/get-disabled-default-alerts-report.sql'
        ),
        get_scan_seconds: sql('alert-notify/get_scan_seconds.sql'),
        get_shield_temp: sql('alert-notify/get_shield_temp.sql'),
        get_conn_offline: sql('alert-notify/get-conn-offline.sql'),
        get_users_report: sql('alert-notify/get-users-report.sql'),
        get_alert_detections_report: sql(
            'alert-notify/get-alert-detections-report.sql'
        ),
        get_recent_notifications: sql(
            'alert-notify/get-recent-notifications.sql'
        ),
    },
    reports: {
        get_issue_tracker_systems: sql('reports/get-issue-tracker-systems.sql'),
        get_issue_mmb_all: sql('reports/get-issue-mmb-all.sql'),
        get_issue_hhm_all: sql('reports/get-issue-hhm-all.sql'),
        get_issue_mmb_older_than_30: sql(
            'reports/get-issue-mmb-older-than-30-days.sql'
        ),
        get_issue_hhm_older_than_30: sql(
            'reports/get-issue-hhm-older-than-30-days.sql'
        ),
        get_issue_mmb_newer_than_30: sql(
            'reports/get-issue-mmb-newer-than-30-days.sql'
        ),
        get_issue_hhm_newer_than_30: sql(
            'reports/get-issue-hhm-newer-than-30-days.sql'
        ),
        get_disabled_alerts: sql('reports/get-disabled-alerts.sql'),
        get_missed_stack_run_mmb: sql('reports/get-missed-stack-run-mmb.sql'),
        get_issue_tracker_report: sql('reports/get-issue-tracker-report.sql'),
        get_unsuccessful_acqu_hhm: sql('reports/get-unsuccessful-acqu-hhm.sql'),
        get_new_online_systems: sql('reports/get-new-online-systems.sql'),
    },
    mmb_rpp: {
        get_edu_configs: sql('mmb-rpp/get-edu-configs.sql'),
        get_edu_dev_config: sql('mmb-rpp/get-edu-dev-config.sql'),
        get_mag_configs: sql('mmb-rpp/get-mag-configs.sql'),
        get_mag_dev_config: sql('mmb-rpp/get-mag-dev-config.sql'),
    },
    preflight_check: {
        get_systems_metadata: sql('preflight-check/get-systems-metadata.sql'),
    },
    odd_jobs: {
        add_pg_table_partitions: sql('odd-jobs/add-pg-table-partitions.sql'),
        get_pg_table_partitions: sql('odd-jobs/get-pg-table-partitions.sql'),
        archive_partitions: sql('odd-jobs/archive-partitions.sql'),
    },
    aws_ff: {
        get_system_list: sql('aws-ff/get-system-list.sql'),
    },
};
