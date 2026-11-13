# GE MRI message codes: inventory and proposed mapping (2026-11-13)

Companion to `PLAN-MRI-INSIGHTS.md` §5 (MRI-2a). Generated read-only from `log.ge_mri_gesys` on prod on 2026-11-13:
- all 374,333 rows, ids 4,749,153 → 5,123,485, **329,480 after dedupe** on the natural key `(system_id, epoch, record_number_concurrent)`;
- 17 systems; device days (from `epoch`, the device wall clock) 2025-05-02 → 2026-11-13.

Only `message_number`, the process (second field of `type`), `message`, `epoch` and `host_datetime` were read, plus counts of `coil` / `psd` / `scan`. Probe scripts and outputs: `~/cv_d3b_evidence/mri/mri2a/` (outside the repo). The draft classifier is `mapping.js` there; it becomes `insight/mri/rules.js` once the mapping is agreed.

**Columns:**
- **Rows**: deduped rows. **Sys**: systems with the code. **Sys-days**: distinct (system, device day). **Sys 30 d**: systems with the code in the last 30 days (`host_datetime`).
- **First / Last**: device days.
- **Tpl**: distinct masked templates of the code.
- **Label**: the most common masked template, with its share of the code's rows. Masking: the system's own host name → `<host>`; MAC, IP, serials → `<mac>` / `<ip>` / `<serial>`; every digit run → `#`; dates → `<date>`; DICOM AE titles and remote host names → `<ae>`. Line breaks are shown as `//`. These labels are internal wording derived from the data, not a decoding.

**The cut (agreed §3 Q3): every code on 3 or more systems or with 100 or more deduped rows.** That is **361 codes and 323,698 rows (98.2%)**. The plan's estimate of "about 200" counted only codes with 100 or more rows (187); 311 codes appear on 3 or more systems. The other 462 codes (5,782 rows) are the long tail (§7).

**Every row counts in `mri.error`** (dim = the code). A named metric is an extra fact on the same row.

## 1. Proposed named metrics (v1) and the codes behind them

22 named metrics. Facts from the draft classifier over all 329,480 deduped rows: **438,116 facts**, of which 329,480 are `mri.error` and 108,636 named. Value sums: `mri.scans_ok` 166,540, `mri.scans_failed` 3,665.

| Metric | Category | Code | Dim(s): rows | Named rows | Of the code's rows | Sys | Sys-days |
|---|---|---|---|---|---|---|---|
| `mri.scans_ok` | utilization | 2218650 | '' 18,428 | 18,428 | 18,428 | 17 | 1,851 |
| `mri.scans_failed` | utilization | 2218650 | '' 18,428 | 18,428 | 18,428 | 17 | 1,851 |
| `mri.exam_started` | utilization | 2218714 | '' 18,223 | 18,223 | 18,223 | 14 | 1,632 |
| `mri.sw_start` | reliability | 200002347 | '' 1,323 | 1,323 | 1,323 | 17 | 1,114 |
| `mri.sw_stop` | reliability | 200002348 | '' 1,120 | 1,120 | 1,120 | 16 | 974 |
| `mri.tps_reset` | reliability | 2227557 | '' 590 | 590 | 590 | 15 | 418 |
| `mri.tps_reset_failed` | reliability | 2227556 | '' 37 | 37 | 37 | 9 | 22 |
| `mri.process_death` | reliability | 2223878 | vre:prescanserver 66, vre:dpserver 20, vre:OrchestraCartes 6, vre:rtpserver 4, vre:rdsserver 1, vre:ERROR 1 | 98 | 98 | 4 | 87 |
| `mri.process_death` | reliability | 200002352 | WindowGroupManager_MV 6, RTPSIServer 6, RTIA 5, cim 4, scn 3, NSP 2, RIR 1 | 27 | 27 | 10 | 26 |
| `mri.process_death` | reliability | 200002354 | autoview 121, RtpHost 38, irm 6, AUTOVOICE 5, OnlineHelp 2, PowerMon 1 | 173 | 173 | 12 | 100 |
| `mri.process_death` | reliability | 200002356 | WavDisp 155, autoview 53, startJVMmxsystem 18, EReportingIcon 3, OnlineHelp 3, fsa 2, irm 2, spectro 2 | 238 | 1,494 | 9 | 200 |
| `mri.process_death` | reliability | 200002381 | DHI 186, diagCoord 185, envMon 185, autoview 173, app 15, AUTOVOICE 5, scn 3, ist 1 | 753 | 753 | 9 | 250 |
| `mri.prescan_failed` | reliability | 2224666 | driver_module_error 635, try_again 423, signal_too_small 371, data_acquisition_error 217, irf_clock_fiber 109, rf_coil_air_temp 98, gradient_not_ready 92, rf_hub_setup 81, door_open 63, invalid_coil 60, other 28, async_stop 11, rf_amp_not_ready 10, stop_button 7 | 2,205 | 2,205 | 17 | 597 |
| `mri.prescan_failed` | reliability | 2224667 | driver_module_error 31, gradient_not_ready 13, try_again 8, rf_hub_setup 6, other 5, rf_coil_air_temp 5, door_open 5, irf_clock_fiber 4, operator_request 4, rf_amp_not_ready 3 | 84 | 84 | 12 | 51 |
| `mri.prescan_failed` | reliability | 2255008 | stop_button 87, table_not_at_scan_plane 10, other 2, pause_button 1 | 100 | 100 | 7 | 73 |
| `mri.autoshim_inconclusive` | reliability | 2224708 | '' 1,678 | 1,678 | 1,678 | 16 | 649 |
| `mri.coil_invalid` | hardware | 2277604 | not_all_connected 1,712, not_compatible 1,695, info_incorrect 84, coil_db_error 67, wrong_port 52 | 3,610 | 3,610 | 8 | 551 |
| `mri.coil_fault` | hardware | 103428 | coil_id_comm 583 | 583 | 583 | 1 | 162 |
| `mri.coil_fault` | hardware | 2252301 | bias_open_circuit 770 | 770 | 770 | 9 | 174 |
| `mri.coil_fault` | hardware | 2252305 | tr_driver_open_circuit 34 | 34 | 34 | 4 | 8 |
| `mri.coil_fault` | hardware | 2252395 | bias_transmit 118 | 118 | 118 | 2 | 28 |
| `mri.coil_fault` | hardware | 2273000 | coil_id_missing 79 | 79 | 79 | 3 | 43 |
| `mri.coil_fault` | hardware | 2273015 | disconnected_while_scanning 10 | 10 | 10 | 3 | 10 |
| `mri.coil_fault` | hardware | 2274023 | bias_open_circuit 73 | 73 | 73 | 4 | 17 |
| `mri.coil_fault` | hardware | 2276129 | connection_error 20 | 20 | 20 | 3 | 14 |
| `mri.cooling_fault` | hardware | 2248604 | gradient_coil_temp_high 17 | 17 | 17 | 4 | 10 |
| `mri.cooling_fault` | hardware | 2261731 | hec_cryo_compressor_flow_low 337 | 337 | 337 | 2 | 199 |
| `mri.cooling_fault` | hardware | 2261732 | hec_cryo_compressor_flow_high 745 | 745 | 745 | 1 | 8 |
| `mri.cooling_fault` | hardware | 2261733 | hec_coolant_temp_high 3,992 | 3,992 | 3,992 | 2 | 112 |
| `mri.cooling_fault` | hardware | 2266402 | leak_sensor_fault 636 | 636 | 636 | 1 | 1 |
| `mri.cooling_fault` | hardware | 2266420 | cabinet_water_flow 16 | 16 | 16 | 4 | 9 |
| `mri.cooling_fault` | hardware | 2266425 | brm_water_flow 5,019 | 5,019 | 5,019 | 2 | 4 |
| `mri.cooling_fault` | hardware | 2268884 | rf_coil_airflow 537 | 537 | 537 | 1 | 43 |
| `mri.rf_amp_fault` | hardware | 101255 | fault 172 | 172 | 172 | 3 | 101 |
| `mri.rf_amp_fault` | hardware | 2248765 | not_operate 16 | 16 | 16 | 3 | 14 |
| `mri.rf_amp_fault` | hardware | 2248775 | mode_change 13 | 13 | 13 | 5 | 12 |
| `mri.rf_amp_fault` | hardware | 2254050 | fault 30 | 30 | 30 | 7 | 29 |
| `mri.rf_amp_fault` | hardware | 2254204 | power_supply 3 | 3 | 3 | 3 | 3 |
| `mri.rf_amp_fault` | hardware | 2254352 | serial_link_broken 47 | 47 | 47 | 7 | 40 |
| `mri.gradient_fault` | hardware | 2244573 | wiring_or_control_undervoltage 7 | 7 | 7 | 5 | 5 |
| `mri.gradient_fault` | hardware | 2244845 | current_distortion 105 | 105 | 105 | 1 | 2 |
| `mri.gradient_fault` | hardware | 2244847 | wiring_or_control_undervoltage 41 | 41 | 41 | 6 | 8 |
| `mri.gradient_fault` | hardware | 2244850 | undervoltage 10 | 10 | 10 | 3 | 8 |
| `mri.gradient_fault` | hardware | 2244851 | current_distortion 16 | 16 | 16 | 3 | 7 |
| `mri.gradient_fault` | hardware | 2244857 | sga_psu_power_off 26 | 26 | 26 | 7 | 19 |
| `mri.gradient_fault` | hardware | 2244858 | sga_psu_wiring 5 | 5 | 5 | 3 | 4 |
| `mri.gradient_fault` | hardware | 2244860 | sga_psu_overcurrent 273 | 273 | 273 | 5 | 12 |
| `mri.gradient_fault` | hardware | 2244861 | sga_psu_overvoltage 3 | 3 | 3 | 3 | 3 |
| `mri.gradient_fault` | hardware | 2244862 | sga_psu_undervoltage 72 | 72 | 72 | 4 | 20 |
| `mri.gradient_fault` | hardware | 2244897 | overtemperature 4 | 4 | 4 | 3 | 3 |
| `mri.gradient_fault` | hardware | 2250082 | data_overrange 461 | 461 | 461 | 2 | 3 |
| `mri.gradient_fault` | hardware | 2250109 | clock_stop 4 | 4 | 4 | 3 | 4 |
| `mri.receiver_fault` | hardware | 2247184 | irf_clock_fiber 89 | 89 | 89 | 3 | 32 |
| `mri.receiver_fault` | hardware | 2267412 | rrx_missing 19 | 19 | 19 | 3 | 9 |
| `mri.receiver_fault` | hardware | 2267425 | irf_no_clock 24 | 24 | 24 | 3 | 14 |
| `mri.receiver_fault` | hardware | 2267432 | refclk_missing 34 | 34 | 34 | 3 | 15 |
| `mri.receiver_fault` | hardware | 2267597 | rrx_not_detected 34 | 34 | 34 | 3 | 9 |
| `mri.receiver_fault` | hardware | 2267637 | agp_fiber_link 18 | 18 | 18 | 3 | 12 |
| `mri.receiver_fault` | hardware | 2270016 | vrf_no_rrx_id 37 | 37 | 37 | 3 | 10 |
| `mri.receiver_fault` | hardware | 2270023 | vrf_error_bits 57 | 57 | 57 | 4 | 18 |
| `mri.receiver_fault` | hardware | 2270024 | vrf_error_bits 49 | 49 | 49 | 3 | 15 |
| `mri.receiver_fault` | hardware | 2270028 | vrf_error_bits 52 | 52 | 52 | 4 | 17 |
| `mri.receiver_fault` | hardware | 2270031 | rrx_fiber_link 8 | 8 | 8 | 3 | 4 |
| `mri.receiver_fault` | hardware | 2270032 | rrx_status 13 | 13 | 13 | 3 | 6 |
| `mri.table_fault` | hardware | 103413 | speed_mismatch 979 | 979 | 979 | 3 | 279 |
| `mri.table_fault` | hardware | 103414 | no_start 39 | 39 | 39 | 3 | 11 |
| `mri.table_fault` | hardware | 103418 | target_miss 200 | 200 | 200 | 3 | 110 |
| `mri.table_fault` | hardware | 103419 | no_start 57 | 57 | 57 | 3 | 47 |
| `mri.table_fault` | hardware | 103453 | home_switch_moved 5,607 | 5,607 | 5,607 | 1 | 163 |
| `mri.table_fault` | hardware | 103466 | cradle_oscillation 2,779 | 2,779 | 2,779 | 2 | 30 |
| `mri.table_fault` | hardware | 2224842 | motion_unexpected 828 | 828 | 828 | 8 | 262 |
| `mri.table_fault` | hardware | 2224864 | motion_too_fast 26 | 26 | 26 | 5 | 21 |
| `mri.table_fault` | hardware | 2261552 | off_plane_while_scanning 208 | 208 | 208 | 8 | 136 |
| `mri.table_fault` | hardware | 2268819 | velocity_tolerance 85 | 85 | 85 | 3 | 44 |
| `mri.table_fault` | hardware | 2268821 | no_start 210 | 210 | 210 | 3 | 110 |
| `mri.table_fault` | hardware | 2268836 | target_miss 125 | 125 | 125 | 2 | 58 |
| `mri.table_fault` | hardware | 2268879 | no_start 36 | 36 | 36 | 3 | 12 |
| `mri.table_fault` | hardware | 2268955 | clutch_slip 587 | 587 | 587 | 2 | 56 |
| `mri.door_sensor_fault` | hardware | 2218716 | '' 1,332 | 1,332 | 1,332 | 9 | 510 |
| `mri.service_mode` | service | 2218663 | on 747 | 747 | 747 | 16 | 445 |
| `mri.service_mode` | service | 2218664 | off 740 | 740 | 740 | 16 | 442 |
| `mri.pm_overdue` | service | 2218671 | unscheduled 1,929 | 1,929 | 1,929 | 8 | 269 |
| `mri.pm_overdue` | service | 2218673 | scheduled 2,404 | 2,404 | 2,404 | 6 | 254 |
| `mri.iq_warning` | service | 2218672 | '' 6,596 | 6,596 | 6,596 | 2 | 459 |
| `mri.system_up` | inventory | 2227566 | DV25.1_R05_2131.a 241, HD23.0_V03_1614.b 236, 12.0_M5B_0846.d 175, HD23.0_V02_1406.a 164, HDE15.0_M4_0943.c 148, SV25.0_R09_1928.b 97, DV26.0_R06_2132.a 83, SV25.1_R07_2127.a 65, HD16.0_V03_1638.a 48, 11.1_M4_0818.a 15, SV25.0_R08_1822.b 7 | 1,279 | 3,481 | 17 | 1,114 |

*Sys* and *Sys-days* count the named rows only. `mri.scans_ok` and `mri.scans_failed` are two facts on the same row (value = the count in the message), so their *n* is the number of exam summaries.

**Value extractors (regex on `message`):**

| Metric | Regex | Gives |
|---|---|---|
| `mri.scans_ok` / `mri.scans_failed` | `No of Successful Scan = (\d+) , No of Failed Scan = (\d+)` | value_num = scans OK / failed. Matches 18,428 of 18,428 rows; 663 summaries are 0 / 0; max 97 OK, 14 failed in one exam. |
| `mri.prescan_failed` | `Prescan failed,\s*(.*)` then a reviewed reason list (`driver_module_error`, `try_again`, `signal_too_small`, `data_acquisition_error`, `irf_clock_fiber`, `rf_coil_air_temp`, `rf_hub_setup`, `door_open`, `invalid_coil`, `gradient_not_ready`, `async_stop`, `stop_button`, `pause_button`, `table_not_at_scan_plane`, `operator_request`, `rf_amp_not_ready`, `dac_setup_failure`) | dim = reason; anything else → `other` (35 rows). attrs.mode = auto / manual. |
| `mri.coil_invalid` | `Invalid coil connected` + the second line | dim = `not_all_connected` / `not_compatible` / `coil_db_error` / `info_incorrect` / `wrong_port` |
| `mri.process_death` | 200002354 `An unexpected death of (\S+) caused it to be restarted`; 200002381 `^Process (\S+), pid \d+ terminated by unexpected signal`; 200002356 `^(\S+) died unexpectedly` (not `dsserver`); 200002352 `HOST_SHUTDOWN was initiated by the death of (\S+)`; 2223878 `crashed on the VRE … Process: (\S+?),` | dim = process (VRE crashes as `vre:<process>`) |
| `mri.system_up` | `^System Up\. sw=(\S+)`, `fieldStrength=(\d+)`, and `gradientAmp`, `RFampType`, `GradCoil`, `GCoilType`, `PowerMonType` (`=(\w+)`) | dim = software version; value_num = field strength in T (`fieldStrength` / 10000); the rest in attrs. Matches 1,279 of the 1,279 'System Up' lines; the code's other 2,202 rows (option `Config:` lists, licence and turnover notices) are `mri.error` only. |
| every fact | the second tab field of `type` | attrs.proc; plus attrs.coil and attrs.psd when those columns are filled (§5 Q-M3 in the plan) |

## 2. Codes behind the named metrics

84 codes, 93,666 rows.

| Metric | Code | Process | Rows | Sys | Sys-days | Sys 30 d | First | Last | Tpl | Label: top masked template (share) |
|---|---|---|---|---|---|---|---|---|---|---|
| `mri.scans_ok`, `mri.scans_failed` | 2218650 | scn | 18,428 | 17 | 1,851 | 8 | 2025-05-02 | 2026-11-13 | 1 | Scn: No of Successful Scan = # , No of Failed Scan = # (100%) |
| `mri.exam_started` | 2218714 | scn, protocol | 18,223 | 14 | 1,632 | 7 | 2025-05-02 | 2026-11-13 | 1 | New Exam Started (100%) |
| `mri.iq_warning` | 2218672 | scn, protocol | 6,596 | 2 | 459 | 1 | 2025-05-02 | 2026-11-13 | 1 | This system has a failure that could significantly degrade Image Quality. Please contact your Service Provider… (100%) |
| `mri.table_fault` | 103453 | NSP | 5,607 | 1 | 163 | 1 | 2026-05-02 | 2026-11-13 | 2 | Warning: Home switch position appears to have moved. // Last home position: # counts // New home position: # c… (96%) |
| `mri.cooling_fault` | 2266425 | NSP | 5,019 | 2 | 4 | 0 | 2026-05-07 | 2026-07-30 | 1 | Cabinet Monitor:A water flow failure was detected on the BRM cooling system. // The system goes to Emergency S… (100%) |
| `mri.cooling_fault` | 2261733 | NSP, diagCoord | 3,992 | 2 | 112 | 0 | 2026-04-30 | 2026-09-10 | 1 | Heat Exchanger Cabinet (HEC) detected customer coolant temperature is out // of specification (too high). // P… (100%) |
| `mri.coil_invalid` | 2277604 | cim | 3,610 | 8 | 551 | 5 | 2025-06-20 | 2026-11-13 | 10 | Invalid coil connected. Scanning is not allowed. // Not all connectors of a multiple connector coil are connec… (47%) |
| `mri.system_up` | 2227566 | mrt_commentator | 3,481 | 17 | 1,114 | 8 | 2025-05-05 | 2026-11-13 | 32 | No class A service licenses are installed. This does not affect clinical use. // Please contact your service r… (10%) |
| `mri.table_fault` | 103466 | NSP | 2,779 | 2 | 30 | 0 | 2026-03-31 | 2026-08-04 | 1 | Cradle motion oscillation has been detected during the move. // Please wait a moment and try the move again. /… (100%) |
| `mri.pm_overdue` | 2218673 | scn, protocol | 2,404 | 6 | 254 | 1 | 2026-04-06 | 2026-10-23 | 1 | This system is overdue for Planned Maintenance. Planned Maintenance has been scheduled for #/#/#. (100%) |
| `mri.prescan_failed` | 2224666 | psc, NSP | 2,205 | 17 | 597 | 8 | 2025-05-08 | 2026-11-12 | 29 | Auto Prescan failed, Driver Module error occurred. (29%) |
| `mri.pm_overdue` | 2218671 | scn, protocol | 1,929 | 8 | 269 | 1 | 2026-04-30 | 2026-11-13 | 1 | This system is overdue for Planned Maintenance. Please contact your Service Provider. (100%) |
| `mri.autoshim_inconclusive` | 2224708 | psc | 1,678 | 16 | 649 | 8 | 2025-05-02 | 2026-11-12 | 1 | Autoshim results inconclusive. Shim values were not changed. // Points used for plane #: #.# %, plane #: #.# %… (100%) |
| `mri.process_death` | 200002356 | hostMonitor | 1,494 | 17 | 1,145 | 8 | 2025-05-06 | 2026-11-13 | 9 | dsserver died unexpectedly, no action being taken. (84%) |
| `mri.door_sensor_fault` | 2218716 | scn | 1,332 | 9 | 510 | 5 | 2025-05-21 | 2026-11-12 | 1 | Door sensor is not working. Please contact your service representative. (100%) |
| `mri.sw_start` | 200002347 | hostMonitor, diagMonitor | 1,323 | 17 | 1,114 | 8 | 2025-05-05 | 2026-11-13 | 1 | The System Software is starting..... (100%) |
| `mri.sw_stop` | 200002348 | hostMonitor | 1,120 | 16 | 974 | 8 | 2025-05-02 | 2026-11-12 | 1 | The System Software has terminated. (100%) |
| `mri.table_fault` | 103413 | NSP | 979 | 3 | 279 | 3 | 2025-12-09 | 2026-11-12 | 4 | The table is moving faster or slower than what was commanded. // Please check for obstructions and try to move… (68%) |
| `mri.table_fault` | 2224842 | NSP | 828 | 8 | 262 | 2 | 2025-05-22 | 2026-11-12 | 5 | Table motion was stopped because it moved differently than expected. // This can occur if the table was moved … (75%) |
| `mri.coil_fault` | 2252301 | NSP | 770 | 9 | 174 | 5 | 2025-05-08 | 2026-11-12 | 3 | Multicoil Bias Fault - Open Circuit. // Try re-seating all coil connectors. // MCD# Channel # of #, counting … (78%) |
| `mri.process_death` | 200002381 | hostMonitor | 753 | 9 | 250 | 3 | 2025-09-09 | 2026-11-10 | 8 | Process DHI, pid # terminated by unexpected signal # (25%) |
| `mri.service_mode` | 2218663 | scn | 747 | 16 | 445 | 3 | 2025-06-19 | 2026-11-12 | 1 | System is being used in GE-Service Mode i.e Patient ID is GESERVICE. (100%) |
| `mri.cooling_fault` | 2261732 | NSP | 745 | 1 | 8 | 0 | 2026-08-04 | 2026-08-14 | 1 | Heat Exchanger Cabinet (HEC) detected the cryogen compressor flow rate // is too high. // This alarm will not … (100%) |
| `mri.service_mode` | 2218664 | scn | 740 | 16 | 442 | 3 | 2025-06-19 | 2026-11-12 | 1 | System is being used in Normal Mode i.e Patient ID is other than GESERVICE. (100%) |
| `mri.cooling_fault` | 2266402 | NSP | 636 | 1 | 1 | 0 | 2026-09-02 | 2026-09-02 | 1 | Cabinet Monitor:Leak Sensor# detects sensor fault. // Please contact your Service Representative and check or … (100%) |
| `mri.tps_reset` | 2227557 | sdm | 590 | 15 | 418 | 6 | 2025-05-06 | 2026-11-13 | 1 | *** Reset/Download TPS In progress. *** (100%) |
| `mri.table_fault` | 2268955 | NSP | 587 | 2 | 56 | 0 | 2026-04-30 | 2026-06-27 | 3 | The system has detected more than expected clutch slip during cradle motion, // motion may be impaired. // Exp… (61%) |
| `mri.coil_fault` | 103428 | NSP | 583 | 1 | 162 | 1 | 2026-05-01 | 2026-11-12 | 1 | Coil validation error: // The table controller (SRI) is unable to communicate with the Coil ID for the // curr… (100%) |
| `mri.cooling_fault` | 2268884 | NSP | 537 | 1 | 43 | 0 | 2026-05-01 | 2026-06-30 | 1 | RF coil airflow sensors measurement warning detected. // Measurement difference: # percent // Warning Toleranc… (100%) |
| `mri.gradient_fault` | 2250082 | NSP | 461 | 2 | 3 | 0 | 2026-07-27 | 2026-10-08 | 2 | Z Axis Gradient Data Overrange Occurred. // The pulse data from upper stream of GP includes higher SR than spe… (99%) |
| `mri.cooling_fault` | 2261731 | NSP | 337 | 2 | 199 | 1 | 2026-05-01 | 2026-10-23 | 1 | Heat Exchanger Cabinet (HEC) detected the cryogen compressor flow rate // is too low. // This alarm will not s… (100%) |
| `mri.gradient_fault` | 2244860 | NSP, diagCoord | 273 | 5 | 12 | 0 | 2025-07-04 | 2026-09-22 | 4 | The GP is reporting a SGA Power Supply OverCurrent Fault.-> (97%) |
| `mri.table_fault` | 2268821 | NSP | 210 | 3 | 110 | 1 | 2026-05-01 | 2026-10-23 | 1 | Cradle didn't start moving when requested. // Last stop position: # um // Current position: # um // Target pos… (100%) |
| `mri.table_fault` | 2261552 | NSP | 208 | 8 | 136 | 3 | 2025-05-07 | 2026-11-12 | 2 | The table moved off of scan plane while scanning. // Scan location: -# // On plane location: -# // Off plane l… (77%) |
| `mri.table_fault` | 103418 | NSP | 200 | 3 | 110 | 3 | 2025-12-09 | 2026-11-11 | 1 | Cradle move failed to reach target position within position tolerance // Target: # um // Actual: # um // Toler… (100%) |
| `mri.process_death` | 200002354 | hostMonitor | 173 | 12 | 100 | 3 | 2025-09-09 | 2026-11-10 | 6 | An unexpected death of autoview caused it to be restarted. (70%) |
| `mri.rf_amp_fault` | 101255 | NSP | 172 | 3 | 101 | 1 | 2026-05-01 | 2026-11-13 | 1 | RF Amplifier Fault. // Error Code: #, Error Parameters: # # # #. -> (100%) |
| `mri.table_fault` | 2268836 | NSP | 125 | 2 | 58 | 1 | 2026-05-01 | 2026-10-16 | 1 | Cradle move failed to reach target position within position tolerance // Target: # um // Acutal: # um // Toler… (100%) |
| `mri.coil_fault` | 2252395 | NSP | 118 | 2 | 28 | 1 | 2026-05-16 | 2026-11-02 | 1 | Multicoil Bias Fault - Transmit Fault. // Try re-seating all coil connectors. // MCD# Channel # of #, counting… (100%) |
| `mri.gradient_fault` | 2244845 | NSP | 105 | 1 | 2 | 0 | 2026-05-04 | 2026-05-07 | 2 | The GP reported mutliple Gradient Amplifier Y Axis Current Distortion // Faults.-> (81%) |
| `mri.prescan_failed` | 2255008 | LxMxConsumer | 100 | 7 | 73 | 2 | 2025-06-06 | 2026-11-11 | 4 | Auto Prescan failed, Stop button was pressed. (87%) |
| `mri.process_death` | 2223878 | NSP | 98 | 4 | 87 | 3 | 2025-05-06 | 2026-10-28 | 6 | A process has crashed on the VRE (<mac>[icn#]). Process: prescanserver, signal causing // the crash: #, time: … (67%) |
| `mri.receiver_fault` | 2247184 | diagCoord, NSP | 89 | 3 | 32 | 0 | 2026-04-27 | 2026-07-08 | 1 | The IRF board clock or fiber cables were interrupted. // TPS Reset required before scanning. (100%) |
| `mri.table_fault` | 2268819 | NSP | 85 | 3 | 44 | 1 | 2026-04-30 | 2026-10-16 | 3 | Velocity tolerance exceeded. // Expected: #um/s // Actual: #um/s (62%) |
| `mri.prescan_failed` | 2224667 | psc | 84 | 12 | 51 | 0 | 2025-05-08 | 2026-10-07 | 15 | Manual Prescan failed, Driver Module error occurred. (37%) |
| `mri.coil_fault` | 2273000 | NSP | 79 | 3 | 43 | 0 | 2026-05-02 | 2026-10-08 | 2 | Coil validation error: // Coil ID device was not detected on a coil. // Coil ID is required for this connector… (99%) |
| `mri.coil_fault` | 2274023 | NSP | 73 | 4 | 17 | 0 | 2026-05-02 | 2026-10-02 | 2 | Coil Fault - Open Circuit // A multicoil bias fault was detected. // Reseat all coils and check coil connectio… (85%) |
| `mri.gradient_fault` | 2244862 | NSP, diagCoord | 72 | 4 | 20 | 1 | 2025-07-04 | 2026-11-05 | 3 | The GP is reporting a SGA Power Supply Under Voltage Fault.-> (92%) |
| `mri.receiver_fault` | 2270023 | LxMxConsumer | 57 | 4 | 18 | 0 | 2026-05-07 | 2026-09-06 | 1 | VRF - Error bit(s) activated in Link Control Status Register (#). // The VRF is located at ICN#(ICN#), if ADS(… (100%) |
| `mri.table_fault` | 103419 | NSP | 57 | 3 | 47 | 3 | 2026-02-03 | 2026-11-09 | 1 | Cradle didn't start moving when requested. Possible obstruction. // Check for obstructions and try to move the… (100%) |
| `mri.receiver_fault` | 2270028 | LxMxConsumer | 52 | 4 | 17 | 0 | 2026-05-07 | 2026-09-06 | 1 | VRF - Error bit(s) activated in RRX Status Register # (#). // The VRF is located at ICN#(ICN#), if ADS(ADS#) /… (100%) |
| `mri.receiver_fault` | 2270024 | LxMxConsumer | 49 | 3 | 15 | 0 | 2026-05-13 | 2026-09-06 | 1 | VRF - Error bit(s) activated in Control Status Register (#). // The VRF is located at ICN#(ICN#), if ADS(ADS#)… (100%) |
| `mri.rf_amp_fault` | 2254352 | NSP | 47 | 7 | 40 | 2 | 2025-05-12 | 2026-11-03 | 1 | RF Amplifier Interface <-> RF Amplifier serial link failure. // The serial link appears to be broken. // Check… (100%) |
| `mri.gradient_fault` | 2244847 | NSP | 41 | 6 | 8 | 1 | 2026-04-13 | 2026-10-16 | 3 | The GP reported a Gradient Amplifier Y Axis Internal Wiring // Fault or Control Undervoltage.-> (83%) |
| `mri.table_fault` | 103414 | NSP | 39 | 3 | 11 | 0 | 2026-04-09 | 2026-10-09 | 1 | Cradle didn't start moving when requested. Possible obstruction. // Check for obstructions and try to move the… (100%) |
| `mri.tps_reset_failed` | 2227556 | sdm | 37 | 9 | 22 | 1 | 2026-02-20 | 2026-10-18 | 1 | *** Reset/Download TPS was not successful. *** (100%) |
| `mri.receiver_fault` | 2270016 | LxMxConsumer | 37 | 3 | 10 | 0 | 2026-05-18 | 2026-08-22 | 1 | VRF did not receive correct device ID from RRX module in // scan room. RRX does not exist or is not connected … (100%) |
| `mri.table_fault` | 2268879 | NSP | 36 | 3 | 12 | 1 | 2026-05-07 | 2026-10-20 | 1 | Cradle didn't start moving when requested. // Last stop position: # um // Current position: # um-> (100%) |
| `mri.coil_fault` | 2252305 | NSP | 34 | 4 | 8 | 2 | 2026-05-01 | 2026-11-10 | 2 | TR Driver Fault Detected - Open Circuit. // Source of Fault is Head TR on Connector A. // Value: # mA Limit: #… (94%) |
| `mri.receiver_fault` | 2267432 | NSP, diagCoord | 34 | 3 | 15 | 0 | 2026-05-13 | 2026-09-06 | 1 | The Reference Clock to the IRF# or IXG is not present.-> (100%) |
| `mri.receiver_fault` | 2267597 | diagCoord | 34 | 3 | 9 | 0 | 2026-05-18 | 2026-08-22 | 1 | The RRX_# module was not detected by IRF#. // The system can not scan without this module.-> (100%) |
| `mri.rf_amp_fault` | 2254050 | NSP | 30 | 7 | 29 | 1 | 2025-06-18 | 2026-10-28 | 1 | RF Amplifier fault #. (100%) |
| `mri.process_death` | 200002352 | hostMonitor | 27 | 10 | 26 | 1 | 2025-05-12 | 2026-10-26 | 7 | A HOST_SHUTDOWN was initiated by the death of WindowGroupManager_MV. (22%) |
| `mri.gradient_fault` | 2244857 | NSP | 26 | 7 | 19 | 1 | 2025-05-12 | 2026-11-03 | 1 | The GP is reporting SGA Power Supply Power Off Fault.-> (100%) |
| `mri.table_fault` | 2224864 | NSP | 26 | 5 | 21 | 1 | 2025-08-21 | 2026-11-13 | 4 | Table motion was stopped because it was moving faster than expected. // This can occur if the table was moved … (50%) |
| `mri.receiver_fault` | 2267425 | diagCoord | 24 | 3 | 14 | 0 | 2026-05-13 | 2026-09-06 | 2 | No Clock Signal to IRF# board. // The IRF# board did not detect a clock signal on the J# fiber optic clock cab… (96%) |
| `mri.coil_fault` | 2276129 | NSP | 20 | 3 | 14 | 1 | 2026-05-10 | 2026-10-21 | 3 | Coil Connection Error. // A receive coil was detected with body transmit disabled. // Connector: Port # (P#)-> (55%) |
| `mri.receiver_fault` | 2267412 | diagCoord | 19 | 3 | 9 | 0 | 2026-05-18 | 2026-08-22 | 1 | Not enough RRX modules found. // The system did not find enough RRX modules for the number of channels // conf… (100%) |
| `mri.receiver_fault` | 2267637 | NSP, diagCoord | 18 | 3 | 12 | 0 | 2026-05-13 | 2026-09-15 | 3 | AGP detected a fault on the fiber links connected to IRF# or IXG or ERF. // The link to this device dropped ou… (72%) |
| `mri.cooling_fault` | 2248604 | NSP | 17 | 4 | 10 | 1 | 2026-05-07 | 2026-10-18 | 1 | Gradient coil temperature high. // Protective automatic shutdown likely if temperature continues // to rise. (100%) |
| `mri.gradient_fault` | 2244851 | NSP | 16 | 3 | 7 | 0 | 2026-04-27 | 2026-07-07 | 2 | The GP is reporting a Gradient Amplifier X Axis Current Distortion // Fault.-> (81%) |
| `mri.cooling_fault` | 2266420 | NSP | 16 | 4 | 9 | 1 | 2026-05-07 | 2026-10-18 | 1 | Cabinet Monitor:A water flow failure was detected on the cabinet cooling system. // The system goes to Emergen… (100%) |
| `mri.rf_amp_fault` | 2248765 | NSP | 16 | 3 | 14 | 1 | 2026-06-01 | 2026-10-19 | 2 | RF Amplifier Error. // RF amplifier failed to go to operate when commanded to do so.-> (88%) |
| `mri.rf_amp_fault` | 2248775 | NSP | 13 | 5 | 12 | 1 | 2026-05-04 | 2026-10-16 | 2 | RF Amplifier Error. // The RF amplifier failed to go into the commanded mode (head or body), // or took too lo… (77%) |
| `mri.receiver_fault` | 2270032 | LxMxConsumer | 13 | 3 | 6 | 0 | 2026-05-13 | 2026-09-06 | 1 | VRF detected RRX status issue. Check the dual fiber optic cable connection from // the RRX to the VRF. Check p… (100%) |
| `mri.coil_fault` | 2273015 | NSP | 10 | 3 | 10 | 0 | 2026-05-04 | 2026-10-09 | 2 | Coil disconnected while scanning or running calibrations. // Connector: Port # (P#)-> (70%) |
| `mri.gradient_fault` | 2244850 | NSP | 10 | 3 | 8 | 2 | 2026-04-28 | 2026-11-05 | 3 | The GP is reporting a Gradient Amplifier Y Axis UnderVoltage Fault.-> (70%) |
| `mri.receiver_fault` | 2270031 | LxMxConsumer | 8 | 3 | 4 | 0 | 2026-05-07 | 2026-07-24 | 1 | RRX to VRF fiber link ERROR. Check the dual fiber optic cable connection from // the RRX to the VRF. Check pow… (100%) |
| `mri.gradient_fault` | 2244573 | NSP | 7 | 5 | 5 | 1 | 2026-04-27 | 2026-11-04 | 3 | The GP reported a Gradient Amplifier X Axis Internal Wiring Fault // or Control Undervoltage.-> (71%) |
| `mri.gradient_fault` | 2244858 | NSP | 5 | 3 | 4 | 0 | 2026-04-27 | 2026-07-10 | 1 | The GP is reporting SGA Power Supply Internal Wiring Fault // or Control Undervoltage.-> (100%) |
| `mri.gradient_fault` | 2250109 | NSP | 4 | 3 | 4 | 0 | 2026-04-27 | 2026-07-24 | 1 | The GP is reporting a Gradient Clock Stop. The GP stopped // receiving a gradient clock signal from the system… (100%) |
| `mri.gradient_fault` | 2244897 | NSP | 4 | 3 | 3 | 1 | 2026-05-05 | 2026-10-16 | 2 | The GP is reporting a Y Axis OverTemperature Fault. // System will wait # minutes before attempting recovery.-… (50%) |
| `mri.gradient_fault` | 2244861 | NSP | 3 | 3 | 3 | 0 | 2026-04-27 | 2026-09-22 | 1 | The GP is reporting a SGA Power Supply Over Voltage Fault.-> (100%) |
| `mri.rf_amp_fault` | 2254204 | NSP | 3 | 3 | 3 | 0 | 2025-08-21 | 2026-08-14 | 1 | SRFD# RF Amplifier Power Supply Fault. // RF Amplifier indicates the high voltage power supply is out of speci… (100%) |

## 3. Companion codes: the same event as a counted one (`mri.error` only)

Counting these too would count one event twice (the CV §6.2 rule). Evidence: the share of the code's rows with the named partner on the same system within the window (device seconds).

| Code | Category | Rows | Sys | Why | Partner within window | Window |
|---|---|---|---|---|---|---|
| 5600 | reliability | 1,303 | 17 | same event as a software start (200002347) | 1,303 / 1,303 | ±5 min |
| 200002364 | reliability | 1,252 | 17 | same event as a software stop (200002348) | 1,118 / 1,252 | ±10 min |
| 2227555 | reliability | 549 | 15 | outcome of a counted TPS reset (2227557) | 548 / 549 | -30 min → 0 s |
| 2219668 | reliability | 587 | 15 | operator prompt during a TPS reset (2227557) | 567 / 587 | ±2 min |
| 2218590 | reliability | 73 | 14 | operator prompt after a TPS reset | 73 / 73 | ±10 min |
| 2224580 | reliability | 372 | 16 | same event as prescan failure 'signal too small' (2224666) | 356 / 372 | ±10 s |
| 2252357 | hardware | 105 | 6 | same event as a prescan failure 'Driver Module error' (2224666 / 2224667) | 105 / 105 | ±30 s |
| 2277563 | hardware | 803 | 6 | detail line of 'Invalid coil connected' (2277604) | 803 / 803 | ±10 s |
| 2277562 | hardware | 1,568 | 7 | detail line of 'Invalid coil connected' (2277604) | 1,568 / 1,568 | ±10 s |
| 2277605 | hardware | 73 | 5 | detail line of 'Invalid coil connected' (2277604) | 73 / 73 | ±10 s |
| 2252293 | hardware | 443 | 13 | header ('Driver Module Has Detected a Fault'); the detail line is counted (coil bias / TR / PSU) | 426 / 443 | ±10 s |
| 2218702 | service | 679 | 15 | same event as service mode on (2218663) | 679 / 679 | ±2 min |
| 2218703 | service | 674 | 15 | same event as service mode off (2218664) | 674 / 674 | ±2 min |
| 2248761 | hardware | 51 | 7 | same event as an RF amplifier fault (101255 / 2254050) | 51 / 51 | ±1 min |
| 2254342 | hardware | 44 | 7 | retry line of the RF amp serial link failure (2254352 / 2254347) | 43 / 44 | ±1 min |
| 2254347 | hardware | 47 | 7 | retry line of the RF amp serial link failure (2254352 / 2254342) | 47 / 47 | ±1 min |
| 2268957 | hardware | 116 | 2 | follow-up of clutch slip (2268955) | 116 / 116 | ±1 min |
| 2250420 | hardware | 541 | 1 | detail line of Z-axis gradient data overrange (2250082) | 459 / 541 | ±10 s |
| 2250421 | hardware | 538 | 1 | detail line of Z-axis gradient data overrange (2250082) | 459 / 538 | ±10 s |
| 2244570 | hardware | 248 | 9 | consequence of a GP gradient-amplifier fault (counted) | 245 / 248 | ±1 min |
| 2247183 | hardware | 88 | 3 | same event as 'IRF board clock or fiber cables were interrupted' (2247184) | 88 / 88 | ±2 min |
| 2268886 | hardware | 527 | 1 | recovery of RF coil airflow warning (2268884), within a day | 527 / 527 | -24 h → 0 s |

**Shutdown signatures, not counted as process deaths** (rows within ±10 min of a software stop or start):

| Code | Rows | Sys | What | Near a stop | Near a start | Neither |
|---|---|---|---|---|---|---|
| 200002356 (dsserver) | 1,256 | 17 | 'dsserver died unexpectedly': every system, about once per software session | 819 | 173 | 264 |
| 200002379 | 5,413 | 16 | 'Process X, pid N exited with status=N' | 5,008 | 327 | 78 |

Process deaths that *are* counted, by the same test: 200002381 `diagCoord` / `envMon` / `DHI` (184 of 185–186 each near a stop, 3 systems) are also shutdown kills; `autoview` (173, 4 near a stop) and every 200002354 restart (autoview 121, RtpHost 38, …; 12% near a stop or start) are not. The plan §5 Q-M1 proposes how MRI-3 separates them.

## 4. Candidate metrics (watch list, not in v1 unless agreed)

| Candidate | Codes | Rows | Sys | Note |
|---|---|---|---|---|
| `mri.scan_stopped_error` | 2218537, 2218527, 2254907 | 514 | 14 | Scan stopped by an error, dim = the reason. Includes operator stops ('by Operator Request', 'Stop button'). Overlaps the failed-scan count in the exam summary; 2218537 and 2218527 are independent of each other (≤ 3% within 10 s). |
| `mri.dicom_push_failed` | 600220200, 600220007, 600220002, 600220203, 600220020, 600220005, 600220009, 600220028 | 4,877 | 6 | PACS push failures from the JVM image-transfer service (refused, timed out, no route, internal error). Site-configuration dependent; as CV's dose export. |
| `mri.worklist_query_failed` | 600100013 | 1,341 | 8 | 'No network connection to SCP in MWL': the modality worklist, as CV's `cv.worklist_query_failed`. |
| `mri.image_display_error` | 100055 | 15,898 | 5 | autoview 'bad format or corrupted image': 15.9k rows on 5 systems, but on only 54 system-days (bursts). |
| `mri.tps_startup_condition_error` | 2256925 | 175 | 9 | 'StartupCondition error on IrfN resulted in TPS reset failure': 103 of 175 within 15 min of a counted TPS failure (2227556); 86 rows on SME21824. |
| `mri.dart_run` | 101200 | 254 | 5 | 'DART Start: Diags Scheduled HAST': exactly one row per system-day on 5 systems (254 / 254), and no result line. A schedule marker. |
| `mri.remote_service_login` | 2227602, 2227603 | 200 | 7 | InSite remote-service log in / out. Unbalanced: 47 log-ins, 153 log-outs. |
| `mri.can_network_fault` | 2252243, 2252246, 2252245, 2252231, 2252247, 2252248, 2252132, 2252133 | 515 | 8 | CAN network management failures / recoveries (patient handling, power monitor, DCERD nodes). |
| `mri.sri_comm_error` | 2249110, 2249107, 2249129, 2249101 | 90 | 9 | SRI (table controller) communication errors. |
| `mri.coil_use` (derive) | the `coil` column | 116,125 rows | 14 | `coil` / `psd` / `scan` are filled only on NSP messages logged during a scan (0 of 18,428 exam summaries); 45% of them are the 'Low signal' prompt. A biased measure of use, so not v1 (plan §5 Q-M3). |

All of them stay visible in `mri.error` by code either way.

## 5. Counted in `mri.error` only, by category

255 codes, 219,351 rows. Codes on the §4 watch list are marked ◇. Category is a reviewed label for the viewer and for CV-style storm rules; it creates no metric.

### 5.1 Utilization

2 codes, 1,532 rows.

| Code | Process | Rows | Sys | Sys-days | Sys 30 d | First | Last | Tpl | Label: top masked template (share) |
|---|---|---|---|---|---|---|---|---|---|
| 2262843 | LxMxConsumer | 808 | 4 | 410 | 3 | 2026-04-28 | 2026-11-12 | 1 | The system is in the standby mode. (100%) |
| 2262844 | LxMxConsumer | 724 | 4 | 379 | 3 | 2026-05-01 | 2026-11-13 | 1 |  // The system is back from the standby mode. (100%) |

### 5.2 Reliability (software, process, network, TPS, prescan, scan)

98 codes, 47,390 rows.

| Code | Process | Rows | Sys | Sys-days | Sys 30 d | First | Last | Tpl | Label: top masked template (share) |
|---|---|---|---|---|---|---|---|---|---|
| 100055 ◇ | autoview | 15,898 | 5 | 54 | 1 | 2025-06-12 | 2026-11-12 | 1 | Received a bad format Or corrupted image. Image will not be displayed (100%) |
| 200002379 | hostMonitor | 5,413 | 16 | 1,072 | 8 | 2025-05-02 | 2026-11-13 | 36 | Process OnlineHelp, pid # exited with status=# (20%) |
| 600220200 ◇ | JVM11645.14, JVM12587.14, … | 2,871 | 5 | 82 | 1 | 2025-05-06 | 2026-10-29 | 3 | SEVERE: NETWORK;SEV#;push failed: <ae> could not perform the operation. Message received from <ae> - A# ( Refu… (99%) |
| 9001 | netserver, UNKNOWN, … | 2,032 | 16 | 837 | 7 | 2025-05-05 | 2026-11-13 | 7 | Unable to set connection - server NETserver host <host>. (41%) |
| 3000004 | LxMxConsumer | 1,886 | 9 | 173 | 3 | 2026-05-01 | 2026-11-13 | 15 | An exception has occurred in MxJVM. // Exception: <date>::::Stack Trace Follows: Exception: java.lang.NumberF… (39%) |
| 600220007 ◇ | JVM14120.14, JVM10522.13, … | 1,523 | 4 | 91 | 2 | 2025-05-08 | 2026-11-09 | 1 | SEVERE: NETWORK;SEV#;push failed: Operation timed out [<ae>]. Retry after some time (100%) |
| 600100013 ◇ | JVM14371.800, JVM14371.801, … | 1,341 | 8 | 70 | 3 | 2025-05-08 | 2026-11-11 | 1 | SEVERE <date> #: There is no network connection to SCP in MWL. Exception in Network session creation for <ae> (100%) |
| 3005 | netserver, UNKNOWN | 1,189 | 15 | 786 | 7 | 2025-05-05 | 2026-11-13 | 10 | Can't connect with <host>:IMSserver // (for message from <host>:imcomb_dcl.#, code: #, tag: #) (40%) |
| 2219782 | scn | 1,148 | 4 | 51 | 1 | 2026-05-04 | 2026-11-12 | 1 | The memory buffer for scan descriptor key is smaller than data in the key #. (100%) |
| 2220018 | scn | 1,142 | 1 | 1 | 0 | 2026-09-30 | 2026-09-30 | 2 | SCIC :: In CoilConfig.cfg, Edge Parameter for SCIC of Head # coil is Out of Range. (50%) |
| 2227073 | scn | 1,099 | 11 | 251 | 6 | 2025-05-08 | 2026-11-09 | 2 | Support routine CFHcveval failed. (99%) |
| 11002 | dcserver | 1,020 | 5 | 80 | 1 | 2026-05-01 | 2026-11-03 | 6 | DCM low level error: Network error (#): Network error (#) (34%) |
| 2223625 | sdm, scn, … | 803 | 16 | 370 | 4 | 2026-02-20 | 2026-11-09 | 33 | Send packet opcode:# seqnum:# rev:# type:# length:# req:SDM_BOX resp:hop_server status:# failed. (43%) |
| 2252700 | diagCoord, NSP | 762 | 3 | 3 | 0 | 2026-04-06 | 2026-07-23 | 8 | Software Error: A call to a VxWorks function returned an error. // VxWorks Function: cm_send interna // Error:… (64%) |
| 2223621 | sdm, scn, … | 698 | 15 | 369 | 4 | 2026-02-20 | 2026-11-09 | 19 | Internal Software Error. Can't callback on undefined NMRID:hop_server. (50%) |
| 11003 | dcserver | 622 | 4 | 61 | 1 | 2026-05-01 | 2026-11-03 | 2 | Failure to get DCM event: no event occured (#) (73%) |
| 2254055 | NSP | 400 | 6 | 125 | 3 | 2026-05-01 | 2026-11-13 | 1 | Recovery in progress, see log. (100%) |
| 2277603 | cim | 360 | 2 | 7 | 0 | 2026-05-05 | 2026-08-05 | 2 | Coil database access error. RecordSet error: EXCEPTION THROWN FROM RecordSetMgr.cc:# - invalid row number: #. … (92%) |
| 2218537 ◇ | scn | 346 | 14 | 197 | 5 | 2025-05-07 | 2026-11-12 | 15 | Scan stopped, Scan Stopped due to error : Scan did not start due to missing trigger. Trigger source is // set … (21%) |
| 2265166 | scn | 346 | 3 | 16 | 1 | 2025-12-16 | 2026-10-22 | 1 | Autovoice Player Server connection error. Unexpected disconnection. (100%) |
| 2265174 | scn | 346 | 3 | 16 | 1 | 2025-12-16 | 2026-10-22 | 1 | Autovoice player encountered an error and currently is not available. Please reboot the system. // If you see … (100%) |
| 2240576 | sdm, protocol | 345 | 6 | 163 | 3 | 2026-04-06 | 2026-10-30 | 2 | Sending the security key request packet failed. Make sure the applications // needed to run the system are up … (100%) |
| 2220140 | scn | 332 | 2 | 7 | 0 | 2026-05-05 | 2026-08-05 | 1 | CIM is Not Responding (100%) |
| 2218630 | scn | 320 | 8 | 113 | 3 | 2025-05-28 | 2026-11-03 | 3 | The download of a prescribed series failed. Internal status code is -#. (89%) |
| 2224613 | psc | 302 | 3 | 131 | 1 | 2025-06-02 | 2026-11-11 | 1 | Prescan was unable to collect CV info from the EPIC process. (100%) |
| 2223850 | NSP | 294 | 8 | 100 | 1 | 2026-04-27 | 2026-11-05 | 56 | Contents of packet can't be routed to a host application: // opcode:# seq:# rev:# type:# length:# stat:-# resp… (60%) |
| 2247144 | diagCoord | 247 | 2 | 15 | 1 | 2025-08-22 | 2026-10-20 | 6 | The IRF driver function Rifdif::rifdif_get_status_update_counter // was called with a bad parameter value. Bad… (80%) |
| 200002372 | hostMonitor | 218 | 5 | 202 | 2 | 2025-05-07 | 2026-11-09 | 4 | The process sdm took too long to start up. (51%) |
| 2219555 | scn, protocol | 209 | 7 | 12 | 0 | 2025-06-03 | 2026-08-03 | 1 | An internal software error occurred. (100%) |
| 2243501 | PPSproxy | 186 | 2 | 173 | 1 | 2026-05-01 | 2026-11-13 | 1 | PPS :: Failure Status Send by IOS process for Event:IN PROGRESS (100%) |
| 2219945 | scn | 186 | 2 | 173 | 1 | 2026-05-01 | 2026-11-13 | 1 | PPS :: Failure to execute event: IN PROGRESS event in PPSproxy process for Exam: # (100%) |
| 2256925 ◇ | LxMxConsumer | 175 | 9 | 26 | 1 | 2025-05-12 | 2026-10-18 | 10 |  // StartupCondition error on Irf# resulted in TPS reset failure. (20%) |
| 2246014 | diagCoord | 174 | 11 | 148 | 2 | 2026-04-27 | 2026-11-10 | 6 | Operating system software error. // The send() routine failed. // Perform a reset if the problem persists. // … (94%) |
| 2252705 | NSP, scn | 174 | 2 | 34 | 1 | 2026-05-01 | 2026-11-06 | 43 | Symbol lookup failed. // MCT received a memory read or load packet or return address packet // to access a sym… (76%) |
| 9007 | netserver | 167 | 5 | 121 | 2 | 2026-05-01 | 2026-11-05 | 1 | read stamp failed (#) Connection reset by peer (100%) |
| 2218527 ◇ | scn | 158 | 11 | 107 | 3 | 2025-06-25 | 2026-11-11 | 17 | Scanning has stopped. Please Try Again. (25%) |
| 2257209 | WavRec | 155 | 1 | 138 | 1 | 2026-05-01 | 2026-11-13 | 1 | No client come up in # seconds. (100%) |
| 2277504 | LxMxConsumer | 139 | 6 | 22 | 2 | 2026-05-01 | 2026-10-21 | 8 | An exception has occurred in WFM. // Exception: <date>::gemriwfm.components.session.MRScanningSession::java.l… (53%) |
| 2267206 | NSP | 137 | 6 | 122 | 3 | 2025-06-06 | 2026-11-11 | 1 | Failure in communication with Data Acquisition Control. Please try again or perform a TPS reset if problem rep… (100%) |
| 2218719 | scn | 135 | 4 | 13 | 2 | 2025-10-15 | 2026-11-06 | 4 | Slice:ConvertMatError:Incorrect Rotmi row[#] = #.# #.# -#.# (37%) |
| 9104 | ifcc, TIR, … | 129 | 4 | 95 | 1 | 2026-04-27 | 2026-11-06 | 1 | Can't connect requestManager to Netserver (100%) |
| 600220002 ◇ | JVM12616.14, JVM10520.13, … | 123 | 3 | 13 | 0 | 2025-07-16 | 2026-07-21 | 1 | SEVERE: NETWORK;SEV#;push failed: Internal Error. Check the network configuration for the host. Also check if … (100%) |
| 600220203 ◇ | JVM8399.15, JVM11617.14, … | 117 | 2 | 10 | 0 | 2025-08-18 | 2026-06-26 | 3 | SEVERE: NETWORK;SEV#;push failed: <ae> could not perform the operation. Message received from <ae> - # ( Proce… (93%) |
| 2274703 | LxMxConsumer | 115 | 7 | 47 | 1 | 2025-06-23 | 2026-11-12 | 1 | Could not start the post-processing application. // Please re-prescribe this post-processing task. (100%) |
| 2240577 | sdm | 111 | 3 | 102 | 1 | 2025-05-07 | 2026-11-09 | 2 | sdm: Communication timed out. // While trying to communicate with the security key, the communication timed ou… (86%) |
| 2223619 | WavRec, psc, … | 109 | 7 | 47 | 1 | 2026-04-06 | 2026-10-26 | 9 | RPC call failed. The NMRID is:WavRec. (49%) |
| 600220020 ◇ | JVM14120.14, JVM26199.15 | 103 | 1 | 2 | 0 | 2025-05-22 | 2025-10-02 | 1 | SEVERE: NETWORK;SEV#;push failed: Illegal value error. Contact FE to fix this problem. (100%) |
| 2257207 | WavRec | 94 | 6 | 91 | 2 | 2026-04-27 | 2026-11-10 | 1 | WavRecCom was restarted. (100%) |
| 2249418 | diagCoord | 88 | 3 | 18 | 1 | 2025-05-12 | 2026-10-20 | 1 | Network problem detected. Check MGD subnet network configuration. // arpResolve failed for IP <ip>, numTries #… (100%) |
| 600220005 ◇ | JVM30817.13, JVM11628.14, … | 80 | 6 | 10 | 0 | 2025-10-08 | 2026-10-14 | 1 | SEVERE: NETWORK;SEV#;push failed: No Route to <ae>. Check the IP address of the remote host. Also ensure that … (100%) |
| 2248345 | psc | 78 | 4 | 61 | 1 | 2025-12-10 | 2026-11-09 | 1 | Please Try Again. (100%) |
| 2223817 | NSP | 54 | 12 | 37 | 2 | 2025-05-12 | 2026-11-03 | 1 | TPS is not responding. Please reset TPS. (100%) |
| 14091 | UNKNOWN, film_composer | 47 | 5 | 40 | 1 | 2026-05-06 | 2026-11-01 | 1 | Could not open file/directory /export/home/sdc/film/.saveState (100%) |
| 2218525 | scn | 45 | 8 | 25 | 2 | 2025-07-31 | 2026-11-02 | 1 | Internal software error // No current scan descriptor (100%) |
| 2218718 | scn | 45 | 4 | 13 | 2 | 2025-10-15 | 2026-11-06 | 1 | Geometry Error found in ConvertMat Function during Download (100%) |
| 2218725 | scn | 45 | 4 | 13 | 2 | 2025-10-15 | 2026-11-06 | 1 | Error occurred during Geometry Calculations. Re-prescribe slices/slab in Graphic Rx Screen. (100%) |
| 600120103 | JVM15695.14, JVM13938.20, … | 42 | 8 | 16 | 0 | 2025-08-08 | 2026-10-09 | 1 | INFO <date> Error occured while showing Image. (100%) |
| 11010 | dcserver | 41 | 3 | 19 | 0 | 2026-05-04 | 2026-08-27 | 3 | Association was rejected from <ae> (78%) |
| 600220009 ◇ | JVM12587.14, JVM12604.14, … | 37 | 3 | 16 | 0 | 2025-05-16 | 2026-10-12 | 1 | SEVERE: NETWORK;SEV#;push failed: Internal Error. Check the network configuration for the host. Also check if … (100%) |
| 2223854 | NSP | 34 | 7 | 28 | 1 | 2025-05-06 | 2026-11-12 | 1 | Extended TPS Reset in progress (up to # minutes). Please be patient.-> (100%) |
| 2247161 | diagCoord | 33 | 3 | 8 | 0 | 2025-05-07 | 2026-07-10 | 11 | UTNS WRITE CONFIRM ERROR // The IRF driver function Utns::utns_set_dtns_mode // failed to write a new control … (27%) |
| 2277672 | diagCoord | 30 | 9 | 25 | 1 | 2025-05-12 | 2026-10-18 | 2 | WARNING: TPS Reset (ICN Improper Shutdown Detection) detected an improper shutdown on // ICN:[icn# MAC=<mac> S… (90%) |
| 2248356 | NSP | 28 | 6 | 21 | 1 | 2025-06-25 | 2026-11-10 | 2 | SSI Watchdog Timeout. // An SSI was not detected in the timeout period. // The PSD or AGP might not be running… (96%) |
| 2218592 | scn | 28 | 5 | 6 | 0 | 2026-05-14 | 2026-09-11 | 3 | The MrMail send of reset to SCP timed out. (86%) |
| 2219300 | RTPSIServer | 26 | 5 | 10 | 1 | 2026-04-06 | 2026-10-26 | 5 | MrMail initialization failed (31%) |
| 2219864 | scn | 23 | 6 | 12 | 0 | 2025-06-20 | 2026-09-24 | 1 | An internal error occurred in List/Select function at #PLANE GRx (#). (100%) |
| 600120300 | JVM27865.14, JVM19020.13, … | 23 | 5 | 17 | 2 | 2025-09-05 | 2026-11-04 | 1 | WARNING <date> An error occured while saving the protocol : Getting null action command. Could not proceed wit… (100%) |
| 2265215 | NSP | 23 | 7 | 16 | 0 | 2025-09-09 | 2026-10-01 | 1 | Autovoice Communication Error. // SCP failed to receive a packet from Host Autovoice Player. // SCP is attempt… (100%) |
| 600220028 ◇ | JVM7954.12, JVM13045.14, … | 23 | 3 | 7 | 1 | 2025-12-09 | 2026-10-20 | 2 | SEVERE: NETWORK;SEV#;push failed: Dicom association request rejected by the remote host <ae>. (61%) |
| 600120900 | JVM9520.29, JVM27838.29, … | 19 | 5 | 16 | 0 | 2025-06-10 | 2026-08-18 | 1 | WARNING <date> EM_WORKFLOW_PROTOCOL_INDEXING_ERROR (100%) |
| 2257200 | WavDisp2, WavRec | 19 | 5 | 8 | 1 | 2026-04-06 | 2026-10-26 | 1 | Failed to initialize MrMail. (100%) |
| 2223883 | NSP | 18 | 5 | 11 | 1 | 2025-05-12 | 2026-11-12 | 1 | VRE reset failed due to failure to communicate with all ICNs! // Check Ethernet and IPMI connectivity to all I… (100%) |
| 2267601 | diagCoord | 18 | 3 | 7 | 0 | 2026-05-07 | 2026-09-02 | 1 | AGP forced TPS_reset to fail because AGP could not successfully // calibrate the Exciters, Receivers, and Rf-H… (100%) |
| 2257210 | WavRec | 17 | 5 | 8 | 1 | 2026-05-01 | 2026-10-26 | 1 | SCP did not respond to the start packet of WavRec. This may be due to a TPS Reset failure. (100%) |
| 2218178 | TIR | 17 | 3 | 6 | 0 | 2026-06-06 | 2026-10-09 | 1 | Cannot find sdc path for image ## (100%) |
| 2267508 | diagCoord | 17 | 3 | 10 | 0 | 2026-05-18 | 2026-08-22 | 3 | AGP forced TPS_reset to fail because AGP could not get SCP to return // status data from the RF Hub. Look for … (88%) |
| 2218624 | scn | 16 | 3 | 8 | 1 | 2026-05-07 | 2026-10-15 | 1 | Failed to execute the next event. (100%) |
| 2218661 | protocol, scn | 15 | 3 | 5 | 0 | 2026-05-01 | 2026-06-16 | 1 | TPS communication failed, please try again. (100%) |
| 2265216 | NSP | 13 | 7 | 13 | 0 | 2025-09-09 | 2026-10-01 | 1 | Autovoice Communication Error. // SCP/Host Autovoice Player link is down. // Please check Host/SCP connection … (100%) |
| 2218512 | scn | 12 | 4 | 4 | 1 | 2026-05-13 | 2026-10-19 | 1 | Internal software error, please try again. (100%) |
| 2265210 | NSP | 12 | 7 | 12 | 0 | 2025-09-09 | 2026-10-01 | 1 | Autovoice Communication Error. // SCP failed to connect to Host Autovoice Player. // Please check Host/SCP con… (100%) |
| 2223880 | NSP | 12 | 4 | 7 | 0 | 2026-02-20 | 2026-08-14 | 3 | Reset TPS was not successful. // Board Failure Status: APS: Fail, // SCP: Pass, // AGP: Pass, // VRE: Fail. //… (42%) |
| 2257118 | scn | 11 | 5 | 7 | 0 | 2025-12-10 | 2026-09-18 | 1 | Internal Software Error. A reboot is required to recover. (100%) |
| 2254907 ◇ | LxMxConsumer | 10 | 4 | 10 | 0 | 2025-07-03 | 2026-09-17 | 3 | Scan Failed. (70%) |
| 2219949 | scn | 9 | 3 | 9 | 1 | 2026-05-07 | 2026-10-19 | 1 | PPS :: Unable to Add PPS unique TAG to Bone List for Exam: # (100%) |
| 2265217 | NSP | 9 | 3 | 7 | 0 | 2025-09-09 | 2026-07-29 | 1 | SCP/Host Autovoice Player link is recovered. (100%) |
| 600200045 | UNKNOWN | 9 | 4 | 7 | 0 | 2025-10-07 | 2026-07-27 | 1 | Database was abruptly shutdown last time, will go for a rebuild (100%) |
| 2267212 | NSP, psc | 9 | 3 | 3 | 0 | 2026-04-23 | 2026-07-10 | 1 | Setting of center frequency failed. Please try again or perform a TPS reset if problem repeats. (100%) |
| 2223859 | NSP | 8 | 4 | 5 | 0 | 2026-02-20 | 2026-07-24 | 1 | The TPS Reset failed because of a VRE reset failure.-> (100%) |
| 2059 | imserver | 8 | 4 | 7 | 0 | 2026-05-05 | 2026-07-27 | 1 | [IMServer> wrong message (100%) |
| 2248376 | NSP | 8 | 4 | 6 | 1 | 2026-05-05 | 2026-10-14 | 2 | Scan location received from the Host while not deactivated, discarded. // Scan Location: # // SCSM State: # (88%) |
| 2252106 | NSP | 6 | 3 | 4 | 1 | 2026-04-23 | 2026-10-26 | 4 | Diagnostic software error. // Failed to determine hardware state for SCP board within # seconds // The board m… (50%) |
| 2224358 | TIR | 6 | 3 | 6 | 0 | 2026-06-06 | 2026-10-09 | 1 | Unable to open image file /export/home#/sdc_image_pool/reserved/T/dbxInstall/#.#/#.#.#.#. Errno = # (100%) |
| 2247151 | diagCoord | 5 | 3 | 3 | 0 | 2026-04-23 | 2026-07-10 | 2 | The IRF driver function Exciter::ex_set_center_freq // failed to write a new control value to the RRF. // Exci… (80%) |
| 2218528 | scn | 4 | 3 | 4 | 0 | 2026-04-28 | 2026-07-30 | 3 | Reference Scan has stopped. VRGF missing (50%) |
| 2257225 | WavDisp, WavDisp2 | 4 | 3 | 4 | 0 | 2026-05-02 | 2026-07-27 | 1 | Failed to send MrMail. (100%) |
| 2248305 | NSP | 4 | 3 | 4 | 0 | 2026-05-14 | 2026-07-26 | 1 | Internal Software Error. It may be necessary to perform a TPS Reset. // An SCT packet send failed. // Packet o… (100%) |
| 600200046 | UNKNOWN | 3 | 3 | 3 | 0 | 2026-05-19 | 2026-06-08 | 1 | DATABASE RECOVERY SUCCESSFUL : # images recovered. (100%) |

### 5.3 Hardware (detail lines and faults with no v1 metric)

40 codes, 2,549 rows.

| Code | Process | Rows | Sys | Sys-days | Sys 30 d | First | Last | Tpl | Label: top masked template (share) |
|---|---|---|---|---|---|---|---|---|---|
| 2252246 ◇ | NSP, diagCoord | 359 | 8 | 183 | 2 | 2025-09-09 | 2026-11-09 | 6 | Quick reset detected on the CAN network. // The node reset and recovered quickly. // Recovered Node is Master … (61%) |
| 2248650 | NSP | 341 | 7 | 145 | 2 | 2025-10-29 | 2026-11-12 | 1 | The patient comfort level is warmer than normal. // The patient may be uncomfortable. // Further increases in… (100%) |
| 2225935 | NSP | 322 | 10 | 44 | 2 | 2025-08-21 | 2026-11-03 | 1 | The PAC does not respond. Check PAC power and fiberoptic connections, // run PAC diags. This error condition a… (100%) |
| 2248651 | NSP | 303 | 7 | 135 | 2 | 2025-10-29 | 2026-11-12 | 1 | The patient comfort level has returned to normal. (100%) |
| 2277506 | LxMxConsumer | 202 | 3 | 82 | 0 | 2026-05-01 | 2026-10-11 | 1 | A trackball problem has occurred. // In Room Display trackball at mouse# could not be detected. (100%) |
| 2252239 | NSP | 159 | 7 | 16 | 1 | 2026-05-07 | 2026-10-18 | 9 | Startup Timeout was detected on the Universal Power Monitor #.-> (19%) |
| 2249267 | NSP | 158 | 2 | 149 | 1 | 2026-05-01 | 2026-11-13 | 1 | Physiological Waveform Data Sequence Error. // SCP-SPU link may have a problem. TPS Reset may be necessary. //… (100%) |
| 2254414 | NSP | 61 | 6 | 39 | 1 | 2025-05-06 | 2026-10-28 | 1 | RF AIF detected RF Lock signal for an extended period of time. // Verify UPM Boards are installed in ASC Chass… (100%) |
| 2248602 | NSP | 45 | 11 | 29 | 2 | 2025-05-12 | 2026-11-03 | 1 | PDU is in Stop mode. Emergency Stop button was pressed or PDU # Volt supply has failed. -> (100%) |
| 2249432 | diagCoord | 44 | 5 | 44 | 2 | 2025-06-06 | 2026-11-03 | 43 | A PCI error occurred. The MCP# received a Target Abort. // Harrier Err Enable Reg: #; Harrier Err Status Reg: … (5%) |
| 2252243 ◇ | NSP, diagCoord | 38 | 6 | 13 | 0 | 2025-08-21 | 2026-09-02 | 8 | Network Management Failure detected on the CAN network. // A CAN node stopped responding to messages. // Faili… (26%) |
| 2277671 | diagCoord | 37 | 3 | 33 | 1 | 2026-05-04 | 2026-11-02 | 4 | ICN sensor detects value out of range. // ICN: [icn# MAC=<mac> SERIAL=<serial> // Sensor: CPU#DIMM // Higher L… (73%) |
| 2249110 ◇ | NSP | 35 | 7 | 22 | 1 | 2025-08-21 | 2026-10-18 | 2 | SRI Communication Error. // SRI failed to respond to a packet from the SCP. // First packet opcode waiting for… (91%) |
| 2249443 | diagCoord | 34 | 7 | 34 | 1 | 2025-05-07 | 2026-10-20 | 33 | A PCI error occurred. The CPV# received no PCI response. // PCI Error Status Reg: #; PCI Error Enable Reg: # /… (6%) |
| 2254786 | NSP | 34 | 5 | 11 | 0 | 2026-05-07 | 2026-09-02 | 2 | The Universal Power Monitor # Has Detected an Invalid Configuration. // Source of Fault is Unblank Cable Miss… (88%) |
| 2249107 ◇ | NSP | 31 | 6 | 17 | 1 | 2025-08-21 | 2026-10-18 | 2 | SRI Communication Error. // The SCP received a packet indicating that SRI has reset.-> (90%) |
| 2252245 ◇ | NSP | 31 | 5 | 9 | 0 | 2025-08-21 | 2026-09-02 | 13 | Network Management Recovery detected on the CAN network. // The node reset and recovered. // Recovered Node is… (19%) |
| 2252231 ◇ | NSP, diagCoord | 30 | 4 | 13 | 0 | 2026-04-28 | 2026-10-13 | 8 | Network Management Recovery detected on the CAN network. // Recovered Node is Patient Handling Power Supplies. (40%) |
| 2252132 ◇ | NSP | 26 | 3 | 26 | 1 | 2026-05-04 | 2026-11-05 | 1 | PDO Communication Failure was detected on the CANopen Protocol. // Node Detecting Failure = SCP. // Node ID = … (100%) |
| 2261264 | NSP | 24 | 5 | 13 | 1 | 2026-05-07 | 2026-10-18 | 1 | The RF Amplifier was not detected but is configured in Guided Install.-> (100%) |
| 2252318 | NSP | 21 | 7 | 19 | 1 | 2025-05-12 | 2026-11-03 | 1 | The Driver Module Has Detected a Power Supply Fault. // Source of Fault is High Voltage Power Supply. // Actua… (100%) |
| 2248622 | NSP, LxMxConsumer | 21 | 8 | 14 | 3 | 2025-08-05 | 2026-10-23 | 1 | RF amplifier is not ready. (100%) |
| 2249129 ◇ | NSP | 19 | 9 | 14 | 2 | 2025-05-12 | 2026-11-03 | 1 | SRI Communication Error. // A reset was not detected when requested to the SRI.-> (100%) |
| 2272058 | LxMxConsumer | 19 | 3 | 9 | 0 | 2026-05-18 | 2026-08-22 | 1 |  // Failed to initialize for ADS synchronization. This is typically and indication that // acquisition hardwa… (100%) |
| 2272085 | LxMxConsumer | 19 | 3 | 9 | 0 | 2026-05-18 | 2026-08-22 | 1 |  // None of the ADS servers present appears to be able to receive control data, // please check configuration… (100%) |
| 2267431 | NSP | 19 | 3 | 9 | 0 | 2026-05-18 | 2026-08-22 | 2 | The IRF# is not ready.-> (79%) |
| 2261239 | NSP | 17 | 3 | 9 | 0 | 2026-05-18 | 2026-08-22 | 2 | ASC NB IF Board was not detected but is configured // in Guided Install.-> (88%) |
| 2252133 ◇ | NSP | 16 | 5 | 15 | 2 | 2026-05-19 | 2026-10-18 | 1 | SDO Communication Failure was detected on the CANopen Protocol. // Node Detecting Failure = SCP. // Node ID = … (100%) |
| 2248615 | NSP | 14 | 7 | 13 | 1 | 2025-08-21 | 2026-10-18 | 1 | PDU Stop mode released. Emergency Stop has been cleared.-> (100%) |
| 2223852 | NSP | 11 | 3 | 6 | 0 | 2026-02-20 | 2026-08-14 | 2 | The APS board reported a communication manager (CM) initialization error. Please check // the error log for a … (73%) |
| 2252247 ◇ | NSP | 11 | 5 | 10 | 0 | 2026-04-28 | 2026-09-06 | 1 | CAN Network Down. // Network Management Failures were detected on all CAN nodes. // The whole network is down.… (100%) |
| 2261230 | NSP | 8 | 5 | 8 | 1 | 2025-05-12 | 2026-11-03 | 1 | The SCP received an unknown frequency identifier from the RF cabinet. // Please perform a TPS Reset. // Freque… (100%) |
| 2249436 | diagCoord | 7 | 4 | 6 | 0 | 2026-02-20 | 2026-07-24 | 3 | Communication problem between the APS (if present in this configuration) // or AGP (if APS not present in this… (43%) |
| 2254344 | NSP | 6 | 3 | 6 | 0 | 2026-04-09 | 2026-08-21 | 1 | RF Amplifier Interface <-> RF Amplifier serial link failure. // The RF Amp failed to respond to the AIF. // If… (100%) |
| 2248645 | NSP | 6 | 5 | 5 | 0 | 2026-05-20 | 2026-07-30 | 1 | Master Gradient is not ready. (100%) |
| 2244720 | NSP | 5 | 4 | 5 | 0 | 2026-04-27 | 2026-07-10 | 1 | DSP# on the GP did not respond to the last interrupt request // (Handshake Error). Please perform a TPS Reset … (100%) |
| 2249101 ◇ | NSP | 5 | 4 | 5 | 1 | 2026-07-08 | 2026-10-18 | 1 | SRI Communication Error. // The SCP received a packet from the SRI containing an unknown opcode. // Opcode: #-… (100%) |
| 2262850 | NSP | 4 | 3 | 4 | 1 | 2025-09-21 | 2026-10-20 | 1 | RF NB Amp Interface Hardware FPGA Load Error. // The processor did not load successfully. // Possible corrupte… (100%) |
| 2252248 ◇ | NSP | 4 | 4 | 4 | 0 | 2026-05-04 | 2026-09-02 | 1 | CAN Network Up. // Network Management Recovery was detected on all CAN nodes. // The whole network is up. (100%) |
| 2261654 | NSP | 3 | 3 | 3 | 0 | 2026-05-18 | 2026-06-13 | 1 | An intermittent failure of the Ethernet connection with the Cooling Cabinet // controller was observed. // The… (100%) |

### 5.4 Service (service mode detail, diagnostics runs, remote service)

24 codes, 6,174 rows.

| Code | Process | Rows | Sys | Sys-days | Sys 30 d | First | Last | Tpl | Label: top masked template (share) |
|---|---|---|---|---|---|---|---|---|---|
| 2248288 | diagCoord | 2,344 | 1 | 106 | 1 | 2025-05-06 | 2026-11-13 | 4 | Diagnostic: IRF->DRF DP Iteration: # of infinite Action: # // Task ID: # Time: # Object: APS // Function: Acqu… (50%) |
| 2247352 | diagCoord | 893 | 1 | 6 | 0 | 2026-05-01 | 2026-05-22 | 2 | Diagnostic: Ex-Rx Signal Iteration: # of infinite Action: # // Task ID: # Time: # Object: APS Test Task // Fun… (98%) |
| 2277651 | diagCoord | 571 | 6 | 34 | 0 | 2025-05-12 | 2026-09-30 | 14 | [icn# MAC=-UNKNOWN- SERIAL=<serial> to determine status of ICN failed. // -> (50%) |
| 101200 ◇ | diagCoord | 254 | 5 | 254 | 4 | 2025-05-06 | 2026-11-13 | 1 | DART Start: Diags Scheduled HAST (100%) |
| 101201 | diagCoord | 254 | 5 | 254 | 4 | 2025-05-06 | 2026-11-13 | 1 | DART End. (100%) |
| 2247814 | diagCoord, 1wireIfSerial, … | 226 | 13 | 187 | 3 | 2025-05-12 | 2026-11-10 | 6 | Diagnostic Communications (DC) error. // Error when reading socket connection. // An automatic attempt will be… (59%) |
| 2246052 | diagCoord | 213 | 4 | 13 | 0 | 2025-12-09 | 2026-09-06 | 13 | Diagnostic: Grad Frame/Clk Iteration: # of infinite Action: # // Task ID: # Time: # Object: SCP Test Task // F… (10%) |
| 2246065 | diagCoord | 187 | 1 | 1 | 0 | 2026-04-28 | 2026-04-28 | 11 | Diagnostic: APS->Bridge DP Iteration: # of infinite Action: # // Task ID: # Time: # Object: APS Test Task // F… (9%) |
| 2277656 | diagCoord | 156 | 1 | 2 | 0 | 2025-05-13 | 2026-04-28 | 1 | Diagnostic: ICN# CPU Stress Iteration: # of infinite Action: # // Task ID: # Time: # Object: Host Test Process… (100%) |
| 2277653 | diagCoord | 156 | 1 | 2 | 0 | 2025-05-13 | 2026-04-28 | 2 | Diagnostic: Host-ICN# Ethernet Path Iteration: # of infinite Action: # // Task ID: # Time: # Object: Host Test… (99%) |
| 2227603 ◇ | insite_msg | 153 | 7 | 139 | 3 | 2025-12-09 | 2026-11-13 | 1 | Insite logged out (100%) |
| 2249372 | diagCoord | 137 | 2 | 2 | 0 | 2026-06-01 | 2026-07-23 | 1 | Communication problem with the host. // Remote command execution (rcmd) failed. // Host: host; RSH Port: #; Lo… (100%) |
| 2277654 | diagCoord | 135 | 1 | 2 | 0 | 2025-05-13 | 2026-04-28 | 1 | Diagnostic: Host-ICN# Ethernet Stress Iteration: # of infinite Action: # // Task ID: # Time: # Object: Host Te… (100%) |
| 2277655 | diagCoord | 128 | 1 | 1 | 0 | 2025-05-13 | 2025-05-13 | 1 | Diagnostic: Host-ICN# IPMI Path Iteration: # of infinite Action: # // Task ID: # Time: # Object: Host Test Pro… (100%) |
| 2247353 | diagCoord | 105 | 1 | 5 | 0 | 2026-05-01 | 2026-05-22 | 2 | Diagnostic: Ex-Rx Signal Iteration: # of infinite Action: # // Task ID: # Time: # Object: APS Test Task // Fun… (67%) |
| 2267578 | diagCoord | 90 | 3 | 6 | 0 | 2026-05-01 | 2026-07-24 | 4 | Diagnostic: DTX Board Level Diagnostics Iteration: # of infinite Action: # // Task ID: # Time: # Object: AGP T… (80%) |
| 2227602 ◇ | insite_msg | 47 | 6 | 43 | 0 | 2025-12-09 | 2026-09-15 | 1 | Insite is logged in (100%) |
| 2249424 | diagCoord | 38 | 5 | 19 | 0 | 2025-09-21 | 2026-07-28 | 1 | Communication problem with the host. // Simple Network Time Protocol (SNTP) request failed. // Host: host; SNT… (100%) |
| 2252289 | NSP, diagCoord | 28 | 3 | 8 | 0 | 2026-06-18 | 2026-09-02 | 4 | Diagnostic: DCB Diag Iteration: # of # Action: # // Task ID: # Time: # Object: SCP // Function: RF: RF Bias //… (43%) |
| 2247816 | diagExec | 22 | 5 | 21 | 2 | 2025-12-03 | 2026-10-23 | 1 | The socket connection between the Diagnostic Coordinator and Executive // has been lost. Process is exiting. /… (100%) |
| 2244855 | diagCoord, NSP | 12 | 3 | 12 | 1 | 2025-12-09 | 2026-10-27 | 4 | Diagnostic: Grad Frame/Clk Iteration: # of infinite Action: # // Task ID: # Time: # Object: SCP // Function: G… (42%) |
| 2227609 | insite_msg | 10 | 4 | 10 | 0 | 2025-12-12 | 2026-09-15 | 1 | iLinq chat request ended (100%) |
| 2247822 | diagCoord | 9 | 3 | 5 | 0 | 2025-12-09 | 2026-07-29 | 5 | The AGP diagnostic test in the Node Run State failed to respond in the allotted time. // This test will be abo… (33%) |
| 2247817 | diagCoord | 6 | 4 | 6 | 0 | 2025-12-09 | 2026-07-29 | 4 | The AGP failed to respond in the allotted time. // Testing will be aborted. // Perform a TPS reset if problem … (50%) |

### 5.5 Inventory

1 codes, 685 rows.

| Code | Process | Rows | Sys | Sys-days | Sys 30 d | First | Last | Tpl | Label: top masked template (share) |
|---|---|---|---|---|---|---|---|---|---|
| 2272059 | LxMxConsumer | 685 | 5 | 300 | 2 | 2026-05-01 | 2026-11-13 | 1 |  // VRF in ICN# is connected to RRX with ID #. (100%) |

### 5.6 Noise (operator prompts, advisories, benign notices; viewer only)

90 codes, 161,021 rows.

| Code | Process | Rows | Sys | Sys-days | Sys 30 d | First | Last | Tpl | Label: top masked template (share) |
|---|---|---|---|---|---|---|---|---|---|
| 2224725 | NSP | 55,433 | 17 | 1,530 | 8 | 2025-05-02 | 2026-11-13 | 1 | Low signal detected. Please check the signal level for receiver # (or receiver # while // using Manual Prescan… (100%) |
| 2218189 | ifcc | 20,027 | 3 | 272 | 2 | 2026-04-30 | 2026-11-13 | 1 | Data Mining: IFCC failed to log data into the file DataMine.dat due to one of the following reasons: fopen, st… (100%) |
| 2228303 | NSP | 18,564 | 15 | 1,221 | 8 | 2025-05-02 | 2026-11-13 | 1 | Part of scan region is outside the PURE calibration volume. // Images will be blank where the scan does not ov… (100%) |
| 2218496 | scn, protocol | 8,433 | 16 | 458 | 3 | 2025-06-19 | 2026-11-12 | 1 | Caution, Investigational Device, Limited by Federal Law to Investigational Use. (100%) |
| 2218089 | ifcc | 7,474 | 1 | 112 | 1 | 2026-06-01 | 2026-11-09 | 1 | Data Mining: IFCC failed to log data into the file DataMine.dat due to one of the following reasons: fopen, st… (100%) |
| 0 | scn, protocol, … | 7,416 | 17 | 333 | 5 | 2025-05-12 | 2026-11-11 | 11 | The message key # was not found. (70%) |
| 600100014 | JVM9637.27, JVM9637.13, … | 6,650 | 5 | 379 | 2 | 2026-04-30 | 2026-11-13 | 2 | WARNING <date> #: An Error has occurred during PPS operation.PPS SCP not configured. (93%) |
| 2218088 | ifcc | 3,352 | 1 | 70 | 0 | 2026-05-01 | 2026-08-10 | 1 | Data Mining: IFCC failed to log data into the file DataMine.dat due to one of the following reasons: fopen, st… (100%) |
| 2276629 | NSP | 2,865 | 4 | 247 | 1 | 2026-04-30 | 2026-10-23 | 1 | Warning: RF Hub RF/Bias bank changed within application. // Bank Index: #-> (100%) |
| 2219581 | scn | 2,738 | 17 | 1,142 | 8 | 2025-05-02 | 2026-11-13 | 1 | A new landmark has been issued since the previous prescription. (100%) |
| 2227991 | NSP | 2,378 | 15 | 702 | 7 | 2025-05-06 | 2026-11-12 | 1 | Part of the ASSET scan region is outside of the ASSET calibration. // Images will be blank where the scan does… (100%) |
| 2219940 | scn, protocol | 1,577 | 3 | 185 | 1 | 2026-04-27 | 2026-11-09 | 2 | PPS :: Action Item : # not Mapped, Please Configure (67%) |
| 2248598 | NSP | 1,490 | 16 | 717 | 8 | 2025-05-07 | 2026-11-13 | 1 | Stop button was pressed. (100%) |
| 2224713 | NSP | 1,246 | 10 | 616 | 5 | 2025-05-02 | 2026-11-12 | 1 | No successful FTG check in # iterations. APS# will run automatically. (100%) |
| 2261661 | NSP | 1,148 | 4 | 274 | 1 | 2026-04-30 | 2026-10-23 | 1 | Cooling Cabinet switching to Low-Power mode after # minutes of inactivity. (100%) |
| 2224727 | psc | 1,003 | 16 | 491 | 5 | 2025-05-02 | 2026-11-12 | 1 | Unable to start prescan! Table not at scan plane. (100%) |
| 2224589 | NSP | 953 | 12 | 234 | 4 | 2025-05-07 | 2026-11-09 | 1 | TG reached the high limit. TG has been set to #. // Check patient positioning and if desired try // Auto Presc… (100%) |
| 2269003 | envMon | 905 | 13 | 368 | 5 | 2025-05-06 | 2026-11-13 | 2 | The device listed below failed to respond in the given time. // Monitoring of the device will be disabled. // … (50%) |
| 2269251 | 1wireIfSerial, 1wireIfUsb, … | 882 | 5 | 652 | 3 | 2025-05-05 | 2026-11-13 | 1 | The Equipment Room Temperature #-Wire Device was not discovered on // the #-Wire Network.-> (100%) |
| 2257260 | NSP | 871 | 10 | 289 | 6 | 2025-05-05 | 2026-11-13 | 1 | Power Monitor Warning: # percent of limit reached for the Body Average. (100%) |
| 2269252 | 1wireIfUsb, 1wireIfSerial, … | 810 | 5 | 662 | 4 | 2025-05-05 | 2026-11-13 | 1 | The Operator Workspace Temperature #-Wire Device was not discovered on // the #-Wire Network.-> (100%) |
| 2218656 | scn, protocol | 762 | 12 | 394 | 3 | 2025-05-02 | 2026-11-13 | 1 | The prescribed coil and plane combination may not give optimal ASSET image quality. (100%) |
| 2220066 | scn | 743 | 10 | 187 | 2 | 2025-06-19 | 2026-10-23 | 1 | Automatic Popup Acknowledge Mask Set : #. (100%) |
| 2267201 | psc | 736 | 13 | 201 | 7 | 2025-05-08 | 2026-11-11 | 2 | Auto Prescan successful. R#=# R#=# TG=# AX= #. Please verify Center Frequency peak. (99%) |
| 2227868 | NSP | 724 | 7 | 276 | 3 | 2026-04-30 | 2026-11-09 | 8 | Scan paused : // Pause button was pressed. (59%) |
| 4034 | geSyslogd | 701 | 11 | 268 | 5 | 2025-05-12 | 2026-11-13 | 8 | An illegal character was changed to a blank in the preceeding error message. // Original character: # (hex) //… (76%) |
| 2269250 | 1wireIfSerial, envMon | 693 | 5 | 258 | 2 | 2025-05-06 | 2026-11-13 | 1 | The Host could not communicate with the #-Wire Network via the Host // USB adapter.-> (100%) |
| 2224379 | app | 620 | 3 | 4 | 0 | 2026-05-01 | 2026-06-05 | 1 | The previous image to be subtracted from image # does not exist in the database for exam #, series #. (100%) |
| 2269015 | 1wireIfUsb, 1wireIfSerial, … | 581 | 5 | 444 | 3 | 2025-06-02 | 2026-11-13 | 2 | The information in the #-Wire Device, GOC Temp, could not be successfully read. // Verify the connections on t… (92%) |
| 2248597 | NSP | 501 | 12 | 312 | 6 | 2025-05-22 | 2026-11-12 | 1 | Pause button was pressed. (100%) |
| 2220048 | scn, protocol | 428 | 2 | 13 | 0 | 2026-05-05 | 2026-10-09 | 1 | Asset.xml file might be corrupt or invalid combination of coil, plane and application. (100%) |
| 2218658 | scn | 415 | 6 | 184 | 3 | 2025-05-06 | 2026-11-11 | 1 | No valid calibration scan is prescribed (100%) |
| 2270060 | LxMxConsumer | 415 | 6 | 210 | 3 | 2026-05-01 | 2026-11-09 | 1 | MR Signal over-range. Re-scan with Auto Prescan or Manual Prescan (reduce R#). (100%) |
| 2276855 | NSP, diagCoord | 400 | 3 | 248 | 1 | 2026-05-01 | 2026-10-23 | 4 | Warning: When parsing PA MUX HART file, bar value was truncated.-> (99%) |
| 2220068 | scn | 384 | 1 | 178 | 1 | 2026-05-01 | 2026-11-12 | 1 | Automatic Popup Acknowledge Mask Set : #. (100%) |
| 10180 | arsjob | 342 | 4 | 305 | 2 | 2026-04-27 | 2026-11-13 | 3 | Resetting ARS <device> - $Id: @(#)ArchiveDevice.o ios <date> $ (51%) |
| 2269013 | 1wireIfSerial | 337 | 3 | 280 | 1 | 2025-05-05 | 2026-11-13 | 40 | A #-Wire Switch in the #-Wire Network could not be set correctly to // access a #-Wire Device. // Switch ID: F… (34%) |
| 10096 | arserver | 324 | 4 | 296 | 2 | 2026-04-27 | 2026-11-12 | 1 | Shutting central archive server process down due to signal: # (100%) |
| 10139 | arserver | 324 | 4 | 296 | 2 | 2026-04-27 | 2026-11-12 | 1 | Closing down the archive server processes. (100%) |
| 2254783 | NSP | 289 | 8 | 103 | 6 | 2025-05-06 | 2026-11-11 | 4 | The Universal Power Monitor # detected a Power Fault on the Body Long Term Average. // Calculated Average = #… (95%) |
| 2268941 | NSP | 288 | 4 | 249 | 1 | 2026-05-01 | 2026-10-23 | 1 | The SRI detected that the cradle is attached while the table is undocked // and/or lowered.-> (100%) |
| 10033 | arsjob | 280 | 4 | 253 | 2 | 2026-05-01 | 2026-11-13 | 1 | There is no media in the drive. (100%) |
| 2268831 | NSP | 279 | 4 | 66 | 1 | 2026-04-30 | 2026-10-17 | 1 | Move request not allowed when table is not docked and fully up (100%) |
| 2220167 | scn | 271 | 10 | 215 | 5 | 2025-05-06 | 2026-11-09 | 1 | A change in coil connection is detected. Some of the tasks need to be re-prescribed again. (100%) |
| 2218668 | scn | 269 | 6 | 97 | 2 | 2025-05-28 | 2026-11-03 | 63 | The download of prescribed series failed for Auto Subtract because of the mismatch in the parameters Imaging O… (14%) |
| 2269257 | 1wireIfSerial | 263 | 2 | 185 | 1 | 2026-05-01 | 2026-10-23 | 2 | The #-Wire mapping process experienced an error attempting to read a // #-Wire device. // Device ID: #F#EFA#-> (86%) |
| 2269025 | 1wireIfSerial | 258 | 2 | 185 | 1 | 2026-05-01 | 2026-10-23 | 1 | The Pen Cabinet Temperature #-Wire Device, pencab_temp, was not // discovered on the #-Wire Network.-> (100%) |
| 104702 | LxMxConsumer | 257 | 2 | 127 | 1 | 2026-05-01 | 2026-11-09 | 1 | Signal overrange detected (R# analog). (100%) |
| 2269026 | 1wireIfSerial | 257 | 2 | 185 | 1 | 2026-05-01 | 2026-10-23 | 1 | The Operator Workspace Temperature #-Wire Device, ow_temp, was not // discovered on the #-Wire Network.-> (100%) |
| 16079 | UNKNOWN | 243 | 7 | 34 | 2 | 2025-12-17 | 2026-11-12 | 1 | [EPD] One non-CT/MR image type found: image skipped (100%) |
| 2220146 | protocol, scn | 226 | 8 | 168 | 4 | 2025-05-23 | 2026-11-05 | 2 | Patient Weight = #.# is incorrect, will not be able to obtain coil information. (88%) |
| 2218600 | scn | 205 | 2 | 68 | 0 | 2026-05-01 | 2026-08-10 | 1 | Invalid CV entered. (100%) |
| 2227162 | scn | 171 | 6 | 89 | 1 | 2026-05-02 | 2026-11-12 | 1 | The number of locations Before Pause cannot exceed # for the current prescription. (100%) |
| 11011 | dcserver | 166 | 2 | 44 | 0 | 2026-05-01 | 2026-06-09 | 8 | ECHO was received from <ae> (29%) |
| 4003 | scn, cim, … | 140 | 7 | 63 | 1 | 2025-05-15 | 2026-11-11 | 1 | Error while formatting Ermes message ## - illegal character in arguments. (100%) |
| 2270061 | LxMxConsumer | 129 | 4 | 70 | 2 | 2026-05-01 | 2026-10-27 | 1 | Signal overrange detected (R# analog) for channel # from Receiver ID #. // The RRX is connected to VRF located… (100%) |
| 2269088 | diagCoord | 122 | 1 | 95 | 1 | 2026-05-13 | 2026-10-23 | 1 | The #-Wire Network detected an invalid USB Link at the In Room Display Interface.-> (100%) |
| 2248108 | NSP | 120 | 6 | 70 | 2 | 2025-05-06 | 2026-11-12 | 1 | APS received data over range error from DRF, on chan = # // Need to reduce receiver gain. (100%) |
| 2269256 | 1wireIfSerial | 99 | 3 | 64 | 0 | 2026-05-01 | 2026-08-22 | 1 | The #-Wire network adapter could not be aquired by the #-Wire software.-> (100%) |
| 2269006 | 1wireIfSerial | 98 | 3 | 63 | 0 | 2026-05-01 | 2026-08-22 | 1 | The #-Wire Interface failed to find a USB device for the #-Wire Network.-> (100%) |
| 2269010 | 1wireIfSerial | 98 | 3 | 63 | 0 | 2026-05-01 | 2026-08-22 | 1 | The #-Wire Interface failed to create the /w/config file on the disk. // Verify power to the PHPS and the stat… (100%) |
| 2252778 | NSP | 85 | 3 | 49 | 1 | 2025-06-25 | 2026-11-10 | 2 | Scan did not start due to missing trigger. Trigger source is // set to: Resp Trigger. Please check the trigger… (99%) |
| 2258027 | LxMxConsumer | 80 | 3 | 8 | 1 | 2026-02-05 | 2026-10-19 | 1 |  // Please perform another calibration scan. (100%) |
| -4 | scn | 75 | 7 | 28 | 2 | 2025-06-11 | 2026-11-02 | 1 | Ermes error, // key: -#, // error: #. (100%) |
| 2248628 | NSP | 61 | 7 | 51 | 2 | 2025-05-07 | 2026-11-12 | 1 | The table is not at scan plane. (100%) |
| 2248631 | NSP | 56 | 4 | 36 | 1 | 2026-05-04 | 2026-11-04 | 1 | Scan room door is open. (100%) |
| 2219894 | scn, protocol | 51 | 10 | 42 | 5 | 2025-07-14 | 2026-11-03 | 9 | The Advisory Error fix for # Slices # did not work with value # (49%) |
| 2219875 | scn, protocol | 40 | 6 | 17 | 1 | 2026-01-26 | 2026-11-03 | 1 | Resp. Trig. still initializing or no valid input available. Please see messages area. (100%) |
| 2242651 | scn | 40 | 4 | 13 | 2 | 2026-05-13 | 2026-11-10 | 1 | Spatial saturation and SpecIR are incompatible. (100%) |
| 17006 | UNKNOWN, anonpatgui | 38 | 6 | 22 | 1 | 2025-12-09 | 2026-10-26 | 1 | [ANON] Successful Anonymous image generation (100%) |
| 5001002 | JVM17228.17, JVM1356.18, … | 37 | 5 | 30 | 2 | 2025-06-25 | 2026-11-12 | 3 | <date> com.ge.med.mediacreator.export.GrowisofsRecord$# run // SEVERE: An error has occurred. Insert new, blan… (54%) |
| 4002 | NSP | 34 | 3 | 14 | 1 | 2025-12-19 | 2026-11-03 | 1 | Error while formatting Ermes message ## - string parameter points // to illegal address. (100%) |
| 2252782 | NSP | 29 | 3 | 7 | 0 | 2026-05-04 | 2026-07-29 | 1 | Scan paused due to missing respiratory trigger for an extended period. // Please check the respiratory device … (100%) |
| 5001001 | JVM11549.18, JVM13735.18, … | 27 | 5 | 27 | 1 | 2025-05-22 | 2026-10-30 | 1 | SEVERE: Missing or wrong type of disk. Please check disk. (100%) |
| 2268899 | NSP | 24 | 3 | 10 | 0 | 2026-05-02 | 2026-09-30 | 1 | Alignment lights can't be turned on without cradle position known. // Please move the cradle to home. (100%) |
| 2218731 | scn | 22 | 4 | 17 | 1 | 2026-05-01 | 2026-11-10 | 1 | Realtime or Fluoro triggering cannot be started until recon is finished. Please wait for completion. (100%) |
| 2268937 | NSP | 19 | 3 | 16 | 0 | 2026-05-04 | 2026-09-18 | 1 | Advance to scan attempted while locked out for workflow efficiency. // See in-room display for next step to pe… (100%) |
| 2268938 | NSP | 18 | 3 | 15 | 1 | 2026-05-04 | 2026-10-20 | 1 | Alignment light landmarking attepted while locked out for workflow efficiency. // See in-room display for next… (100%) |
| 2257114 | scn | 17 | 3 | 11 | 1 | 2026-05-20 | 2026-10-18 | 1 | Can not download this application since previous recon is in progress. Please try after recon is complete (100%) |
| 2254911 | LxMxConsumer | 15 | 5 | 9 | 2 | 2025-06-02 | 2026-11-11 | 2 | Paused. The table is not at scan plane. (67%) |
| 5001007 | JVM17641.13, JVM1945.13, … | 12 | 4 | 12 | 1 | 2025-06-25 | 2026-10-16 | 1 | SEVERE: Disk is not empty. Please insert a blank disk. (100%) |
| 4004 | NSP, psc | 11 | 5 | 7 | 1 | 2026-05-15 | 2026-11-11 | 1 | Unable to find Ermes message ## while formatting Ermes message ##. (100%) |
| 2218503 | scn | 10 | 4 | 6 | 0 | 2025-10-20 | 2026-10-02 | 2 | Cannot start auto prescan. Coil is either disconnected or connected to a different coil port. Please reconnect… (90%) |
| 2267248 | NSP | 10 | 3 | 9 | 1 | 2026-05-04 | 2026-11-09 | 1 | Retry XTG failed. APS# will run automatically. (100%) |
| 2219044 | hgp | 9 | 4 | 7 | 0 | 2026-05-15 | 2026-09-11 | 1 | The user request to Record ECG sent to MCT. (100%) |
| 4028 | geSyslogd | 7 | 5 | 7 | 0 | 2025-05-09 | 2026-08-14 | 7 | The GE System Log was pruned. // The history appearing before the cutoff point has been removed. // Cutoff poi… (14%) |
| 2219045 | hgp | 7 | 4 | 7 | 0 | 2026-05-15 | 2026-09-11 | 1 | Record ECG returned with Stauts - Success. (100%) |
| 2248444 | NSP | 6 | 5 | 5 | 0 | 2026-05-28 | 2026-07-29 | 1 | The Gating Subsystem can not be reset during scanning. (100%) |
| 2242710 | scn | 5 | 3 | 4 | 0 | 2026-07-01 | 2026-07-24 | 3 | EPI ASSET is incompatible with #NVARRAY_A. (40%) |
| 2265487 | MRFunctool_4720, MRFunctool_18961, … | 3 | 3 | 3 | 0 | 2025-11-21 | 2026-06-24 | 1 | Some images have been rejected (100%) |

## 6. Totals by category (codes above the cut)

| Category | Codes | Rows | Of which named-metric codes | Companion codes |
|---|---|---|---|---|
| utilization | 4 | 38,183 | 2 | 0 |
| reliability | 117 | 61,208 | 13 | 6 |
| hardware | 117 | 39,177 | 63 | 14 |
| service | 31 | 19,943 | 5 | 2 |
| inventory | 2 | 4,166 | 1 | 0 |
| noise | 90 | 161,021 | 0 | 0 |
| **all** | **361** | **323,698** | | |

## 7. The long tail: below the cut, `mri.error` only

462 codes, 5,782 rows (1.8%). Each is on 1–2 systems with fewer than 100 rows. Listed as code (rows), by main process, so the reviewed-code set is complete as of 2026-11-13; none is in a named metric.

- **NSP** (208): 2254012 (89), 2261704 (74), 2249105 (71), 2273220 (70), 2276860 (70), 2245530 (69), 2268901 (60), 2276502 (56), 2268900 (55), 2268902 (55), 2262601 (53), 2267218 (48), 2268909 (47), 2224583 (41), 2224862 (41), 2266426 (40), 2250410 (37), 2250411 (37), 2252288 (33), 2252706 (31), 2248008 (31), 2248102 (31), 2261716 (31), 2261725 (31), 2252396 (30), 2265211 (29), 2268904 (29), 2274021 (26), 2249149 (23), 103411 (22), 2276802 (20), 2276804 (20), 2276803 (20), 2276805 (20), 2245504 (20), 2244859 (19), 101257 (19), 2223894 (18), 2268906 (17), 2267836 (17), 2249151 (17), 102968 (16), 2274035 (15), 2248759 (13), 2248163 (13), 2227337 (12), 2252730 (12), 2252232 (12), 2249271 (12), 2244598 (12), 2261601 (11), 2228004 (10), 2267229 (10), 2274033 (10), 2254152 (10), 2268822 (10), 2261719 (10), 2261712 (10), 2261723 (10), 2267208 (9), 2268933 (9), 2228179 (9), 2254367 (9), 2250412 (9), 2245526 (9), 2268880 (9), 102902 (9), 2227922 (9), 2244870 (8), 2268834 (8), 2223886 (8), 2245524 (8), 2252131 (8), 2254212 (7), 2250083 (7), 102963 (7), 2245527 (7), 2245529 (7), 2268846 (7), 102856 (7), 2224529 (7), 2223881 (6), 2254781 (6), 2223892 (6), 2245501 (6), 2223849 (6), 2268801 (6), 2261705 (6), 2262135 (5), 2268905 (5), 105016 (5), 2268816 (5), 2267210 (5), 2227859 (5), 2267709 (5), 2244597 (5), 2248768 (4), 2267205 (4), 2275652 (4), 103415 (4), 2262605 (4), 2248477 (4), 103416 (4), 2245525 (4), 2245528 (4), 2267652 (4), 2261702 (4), 2275212 (4), 102869 (4), 2244589 (4), 2248666 (4), 2248644 (3), 2262134 (3), 2248337 (3), 2262606 (3), 2244723 (3), 2248847 (3), 2254616 (3), 2254782 (3), 103439 (3), 2268873 (3), 2268804 (3), 2224549 (3), 2223847 (3), 2274052 (3), 2273010 (3), 2228304 (3), 2266427 (3), 2269934 (3), 2254373 (3), 2228007 (3), 2224718 (3), 2244588 (3), 2261703 (3), 2268802 (3), 2268877 (3), 2268815 (3), 2224672 (2), 2228719 (2), 2248606 (2), 2248607 (2), 2265212 (2), 2273018 (2), 2252284 (2), 2248763 (2), 2252112 (2), 2244898 (2), 2254341 (2), 2268930 (2), 2228419 (2), 2275712 (2), 2261709 (2), 2268837 (2), 2261664 (2), 2261653 (2), 2252151 (2), 2257268 (2), 103461 (2), 2228726 (2), 2268820 (2), 2244874 (1), 2252302 (1), 2248238 (1), 2267224 (1), 2254349 (1), 2267211 (1), 2252709 (1), 102953 (1), 2254404 (1), 2223896 (1), 2223889 (1), 2268961 (1), 2252287 (1), 2252285 (1), 2248524 (1), 101409 (1), 103417 (1), 103429 (1), 2252394 (1), 103430 (1), 101424 (1), 2261140 (1), 2268824 (1), 2223851 (1), 2273821 (1), 103003 (1), 103004 (1), 2261701 (1), 2261707 (1), 2261722 (1), 2248336 (1), 2268920 (1), 2267638 (1), 102829 (1), 2223882 (1), 2224702 (1), 2248016 (1), 2244578 (1), 2244605 (1), 2249148 (1), 2261718 (1), 2261679 (1), 2248593 (1), 2275207 (1), 2274507 (1), 2262603 (1), 2224531 (1), 2254215 (1)
- **diagCoord** (103): 2247160 (86), 2249351 (82), 105005 (81), 105045 (76), 2267576 (75), 2252712 (73), 2247163 (68), 2264947 (64), 2253633 (60), 2245233 (57), 2248209 (56), 2247340 (56), 2253614 (50), 2247382 (43), 2253849 (41), 2277662 (40), 2246041 (35), 2246068 (35), 2247806 (34), 2252714 (34), 2246002 (33), 2252738 (32), 2252733 (32), 2246044 (31), 2252726 (28), 2247157 (25), 2249336 (23), 2247156 (23), 2261002 (23), 2261011 (23), 2249305 (20), 2246877 (20), 2267502 (19), 2249307 (18), 2253592 (18), 2252728 (17), 2267410 (15), 2261045 (15), 2269141 (14), 2247350 (12), 2252716 (11), 2249381 (11), 2261926 (10), 2261914 (10), 2267517 (9), 2252711 (9), 2247154 (7), 2267636 (7), 2244607 (6), 2245057 (6), 2245261 (6), 2267604 (6), 2249407 (5), 2247819 (5), 2245309 (5), 2247159 (5), 2267414 (5), 2267582 (5), 2267519 (5), 2246043 (5), 2253605 (5), 2252739 (5), 2253559 (5), 2249345 (4), 2253596 (4), 2248217 (4), 2247339 (4), 2247808 (3), 2253550 (3), 2246006 (3), 105078 (3), 2246604 (3), 2246821 (3), 2246803 (3), 2247143 (3), 2247815 (2), 2262937 (2), 2262931 (2), 2247181 (2), 2249425 (2), 2246033 (2), 105051 (2), 2244848 (2), 2247308 (2), 2253593 (1), 2247378 (1), 2249420 (1), 2246027 (1), 2253615 (1), 2247150 (1), 2247148 (1), 2252710 (1), 2261910 (1), 2264948 (1), 2245055 (1), 2247120 (1), 2267626 (1), 2267559 (1), 2267609 (1), 2249387 (1), 2246049 (1), 2246004 (1), 2267647 (1)
- **scn** (45): 2220169 (94), 2217504 (87), 2220187 (51), 2218510 (24), 2218774 (22), 2220049 (17), 2217494 (15), 2220147 (15), 2227387 (13), 2219663 (12), 2219628 (12), 2220007 (12), 2242954 (9), 2219712 (7), 2242884 (7), 2219570 (6), 2219803 (6), 2218711 (6), 2227389 (5), 2242789 (4), 2218709 (4), 2227190 (4), 2242650 (3), 2218523 (3), 2218501 (2), 2242743 (2), 2218529 (2), 2218704 (2), 2219992 (2), 2220151 (2), 2218616 (2), 2218741 (2), 2227256 (2), 2242792 (1), 2227005 (1), 2227008 (1), 2218574 (1), 2218568 (1), 2242868 (1), 2242680 (1), 2257102 (1), 2219858 (1), 2219977 (1), 2220003 (1), 2220014 (1)
- **LxMxConsumer** (22): 2254812 (46), 2270029 (38), 2255482 (36), 104703 (30), 2255485 (21), 2228421 (18), 2261685 (18), 2270062 (17), 2256261 (9), 2258030 (7), 2270080 (6), 2272079 (5), 2254908 (5), 2261657 (5), 2258013 (4), 2261681 (2), 2261658 (2), 2224714 (2), 2256923 (1), 2270065 (1), 2256853 (1), 2258012 (1)
- **1wireIfSerial** (8): 2269023 (36), 2269012 (11), 2269258 (4), 2269021 (3), 2269016 (1), 2269017 (1), 2269019 (1), 2269024 (1)
- **dbwserver** (7): 9028 (56), 9071 (43), 9056 (43), 9008 (35), 9019 (2), 1029 (1), 9064 (1)
- **UNKNOWN** (7): 17002 (46), 2219226 (43), 16051 (16), 17005 (5), 16002 (2), 600200044 (2), 600200047 (1)
- **hostMonitor** (7): 200002321 (6), 200002322 (6), 200002368 (6), 200002317 (2), 200002329 (1), 200002331 (1), 200002357 (1)
- **dcserver** (6): 11028 (34), 11024 (17), 11004 (8), 11029 (7), 11001 (2), 11039 (1)
- **psc** (6): 2224597 (17), 2224538 (4), -1 (2), 2224539 (1), 2224690 (1), 2224567 (1)
- **arserver** (4): 10213 (96), 9047 (96), 10062 (48), 10192 (11)
- **cim** (3): 2277565 (22), 2258100 (4), 2277608 (2)
- **hop_server** (3): 2240416 (3), 2240418 (1), 2223630 (1)
- **logermes** (2): 2223885 (8), 102006 (1)
- **RtpHost** (2): 2228431 (5), 2228432 (3)
- **protocol** (2): 2257119 (4), 2219812 (2)
- **remoteSrv** (2): 2223640 (2), 2223639 (2)
- **MRFunctool_** (2): 2265438 (2), 2265440 (1)
- **geSyslogd** (2): 4027 (2), 4035 (1)
- **arsjob** (1): 10032 (49)
- **mrPasting_** (1): 101502 (43)
- **MRFunctool_** (1): 2265525 (30)
- **MRFunctool_** (1): 2265396 (8)
- **prsserver** (1): 14145 (6)
- **download_gradshim** (1): 2223616 (4)
- **JVM** (1): 5001014 (4)
- **cmdb_proxy** (1): 2223671 (3)
- **WavRec** (1): 2257203 (2)
- **ifcc** (1): 2218184 (2)
- **MRFunctool_** (1): 2265258 (2)
- **netserver** (1): 3015 (2)
- **imserver** (1): 2051 (2)
- **JVM** (1): 5001009 (2)
- **JVM** (1): 600110901 (2)
- **JVM** (1): 5001004 (1)
- **JVM** (1): 600220025 (1)
- **coilCK** (1): 2258103 (1)
- **RIR** (1): 2219400 (1)
- **JVM** (1): 600110701 (1)
- **MRFunctool** (1): 2265312 (1)
