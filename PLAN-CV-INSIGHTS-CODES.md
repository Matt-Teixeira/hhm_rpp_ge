# GE CV error codes: inventory and proposed mapping (2026-11-09)

Companion to `PLAN-CV-INSIGHTS.md` §6 (CV-2 groundwork). Generated read-only
from `log.ge_cv_syserror` (both live systems, SME02412 and SME08640; all
96,204 rows, device days 2026-04-30 → 2026-11-08, captures up to
2026-11-09 14:03 UTC). Only `errorcode`, `subsystem`,
`exceptioncategory`, `debugtext`, `sourcefile`, `repeatcount` and the
time and sequence columns were read; GE's encoded fields were not.

- **Rows** count *counted* rows: RTA relays are excluded and shown in **Relays** (§6.2 of the plan).
- **Label** is the most common readable debug-text template of the code
  (digits and hex masked as `#`), with its share of the code's rows. It is
  internal wording derived from the data (plan §2 item 4), not a decoding.
- **Sys-days** = distinct (system, device day) pairs with the code.
- Probe scripts: `~/cv_d3b_evidence/cv2/` (outside the repos).

## 1. Proposed named metrics (v1) and the codes behind them

Every code below also counts in `cv.error`. A named metric takes only the rows whose debug text matches (column *named rows*).

| Metric | Code | Dim(s) | Named rows | Of the code's rows |
|---|---|---|---|---|
| `cv.detector_com_error` | 1200014 | scanSetupDm 11685, setCommonVoltageDm 11660, scanModeDm 11643, _getSensorDm 4782, waitRxCommandDm 194 | 39964 | 39964 |
| `cv.detector_com_error` | 1200114 | waitRxCommandDm 49 | 49 | 49 |
| `cv.positioner_collision` | 1050168 | lift 2460 | 2460 | 2460 |
| `cv.positioner_collision` | 1050170 | collimator 1657 | 1657 | 1657 |
| `cv.anticollision_error` | 1050143 | pivot 1669 | 1669 | 1669 |
| `cv.anticollision_error` | 1050302 | table_lat 1611 | 1611 | 1611 |
| `cv.anticollision_error` | 1050144 | c_arc 810 | 810 | 810 |
| `cv.anticollision_error` | 1050177 | front_l_arm 120, front_pivot 118, front_arc 107, front_lift 99 | 444 | 444 |
| `cv.anticollision_error` | 1050145 | lift 410 | 410 | 410 |
| `cv.anticollision_error` | 1050301 | table_long 379 | 379 | 379 |
| `cv.anticollision_error` | 1050142 | l_arm 1 | 1 | 1 |
| `cv.table_encoder_failure` | 1050710 | lateral 2679 | 2679 | 2679 |
| `cv.table_encoder_failure` | 1050188 | rotation 135 | 135 | 135 |
| `cv.table_encoder_failure` | 1050182 | longitudinal 115 | 115 | 115 |
| `cv.table_encoder_failure` | 1050709 | height 32 | 32 | 32 |
| `cv.table_encoder_failure` | 1050711 | longitudinal 9 | 9 | 9 |
| `cv.table_encoder_failure` | 1050187 | rotation 2 | 2 | 2 |
| `cv.pib_com_loss` | 1050024 | reset 730, fail 49 | 779 | 779 |
| `cv.emergency_backout` | 1050297 | '' 724 | 724 | 2506 |
| `cv.dose_export_rejected` | 2800176 | '' 1250 | 1250 | 1250 |
| `cv.worklist_query_failed` | 2800036 | network_failed 637 | 637 | 637 |
| `cv.worklist_query_failed` | 2800175 | wl_query_failed 40 | 40 | 40 |

## 2. Codes behind the named metrics

22 codes, 57,638 counted rows.

| Code | Sub | Cat | Rows 02412 | Rows 08640 | Sys-days | First | Last | Relays | Label: top debug-text template (share) | Source file |
|---|---|---|---|---|---|---|---|---|---|---|
| 1200014 | RTA | AR | 39964 | 0 | 13 | 2026-05-19 | 2026-10-21 |  | [FPGA_Driver::update] Detector com error: CDetectorImpl::setCommonVoltageDm Ack error - Expected: # - # - Rece (29%) | fpga_driver.cpp |
| 1050710 | POS | WR | 2641 | 38 | 60 | 2026-05-01 | 2026-11-05 | 2652 | Table:lateral axis encoder, potentiometer failure,TBL LAT out of range (100%) | table_geometry_task.c |
| 1050297 | POS | DO | 1582 | 924 | 232 | 2026-05-01 | 2026-11-06 |  | Rack has been resetted for a PIB loss of communication. (29%) | poslayer.c |
| 1050168 | POS | DO | 1765 | 695 | 291 | 2026-05-01 | 2026-11-08 | 1829 | LIFT COLLISION (T:#x# H:#x# U:#x#). (100%) | saf_safetytask.c |
| 1050143 | POS | DO | 1667 | 2 | 25 | 2026-06-01 | 2026-11-03 | 359 | ANTICOLLISION CINEMATIC ERROR (#x# HW:#x# & US:#x#), position error on Pivot (82%) | anticol_task.c |
| 1050170 | POS | DO | 524 | 1133 | 292 | 2026-04-30 | 2026-11-08 | 1276 | COLLIMATOR COLLISION (T:#x# H:#x# U:#x#). (100%) | saf_safetytask.c |
| 1050302 | POS | DO | 428 | 1183 | 163 | 2026-05-01 | 2026-11-08 | 1208 | ANTICOLLISION CINEMATIC ERROR (#x# HW:#x# & US:#x#), speed error on table lat (100%) | anticol_task.c |
| 2800176 | DL | DO | 531 | 719 | 296 | 2026-05-01 | 2026-11-08 |  | Dose Export logger - Debug text:Association rejected, Minor code:MC_ASSOCIATION_REJECTED, Note: (100%) | DJRDELogger.cxx |
| 1050144 | POS | DO | 810 | 0 | 15 | 2026-05-07 | 2026-10-06 | 147 | ANTICOLLISION CINEMATIC ERROR (#x# HW:#x# & US:#x#), position error on C_Arc (97%) | anticol_task.c |
| 1050024 | POS | DO | 779 | 0 | 7 | 2026-09-11 | 2026-09-18 | 523 | PIB : COM Reset (94%) | pib_task.c |
| 2800036 | DL | DO | 342 | 295 | 194 | 2026-05-01 | 2026-11-06 |  | Internal Error, # : BROWSER_NETWORK_FAILED (96%) | MwlDJRLogger.cxx |
| 1050177 | POS | DO | 444 | 0 | 6 | 2026-09-11 | 2026-09-18 | 77 | Anticollision error on axis Front L Arm in motion state # (14%) | geometry_task.c |
| 1050145 | POS | DO | 410 | 0 | 4 | 2026-09-12 | 2026-09-18 | 44 | ANTICOLLISION CINEMATIC ERROR (#x# HW:#x# & US:#x#), position error on Lift (71%) | anticol_task.c |
| 1050301 | POS | DO | 379 | 0 | 12 | 2026-05-19 | 2026-10-21 | 63 | ANTICOLLISION CINEMATIC ERROR (#x# HW:#x# & US:#x#), position error on table long (54%) | anticol_task.c |
| 1050188 | POS | DO | 135 | 0 | 30 | 2026-05-01 | 2026-10-22 |  | Table rotation encoder failure, encoder not calibrated (T:#x# H:#x# U:#x#) (100%) | table_rotation.c |
| 1050182 | POS | WR | 115 | 0 | 22 | 2026-05-11 | 2026-11-04 | 91 | Table Long : Potentiometer/encoder mismatch. Motion halted. (T:#x# H:#x# U:#x#) (80%) | saf_motionerrors.c |
| 1200114 | RTA | DO | 43 | 6 | 26 | 2026-05-01 | 2026-10-20 |  | [FPGA_Driver::update] Detector com error: CDetectorDipb::waitRxCommandDm RX read timeout (# ms), RX IT never r (96%) | fpga_driver.cpp |
| 2800175 | DL | DO | 16 | 24 | 11 | 2026-05-05 | 2026-10-29 |  | Association timeout, # : BROWSER_WL_QUERY_FAILED (65%) | MwlDJRLogger.cxx |
| 1050709 | POS | WR | 32 | 0 | 3 | 2026-09-15 | 2026-09-17 |  | Table:Height potentiometer failure,TBL HEIGHT out of range (100%) | table_geometry_task.c |
| 1050711 | POS | WR | 9 | 0 | 4 | 2026-05-07 | 2026-10-15 | 8 | Table:Longitudinal axis potentiometer failure,TBL LONG out of range (100%) | table_geometry_task.c |
| 1050187 | POS | DO | 2 | 0 | 1 | 2026-09-15 | 2026-09-15 |  | Can't communicate with table rotation encoder (T:# H:#x# U:#x#) (100%) | table_rotation.c |
| 1050142 | POS | DO | 1 | 0 | 1 | 2026-05-14 | 2026-05-14 | 1 | ANTICOLLISION CINEMATIC ERROR (#x# HW:#x# & US:#x#), speed error on L-arm (100%) | anticol_task.c |

## 3. Candidate metrics (watch list, not in v1 unless agreed)

| Candidate | Code | Rows |
|---|---|---|
| `cv.positioner_reset` | 1050297 | 868 |
| `cv.positioner_boot` | 1050297 | 151 |
| `cv.shutdown_requested` | 3400037 | 98 |
| `cv.detector_offset_out_of_range` | 1200019 | 11418 |
| `cv.collimator_comm_failure` | 600104 | 590 |
| `cv.collimator_comm_failure` | 600501 | 291 |
| `cv.positioner_link_lost` | 600105 | 472 |
| `cv.positioner_link_lost` | 1000025 | 430 |
| `cv.positioner_link_lost` | 1050686 | 144 |

## 4. Codes behind the candidates only

7 codes, 13,443 counted rows.

| Code | Sub | Cat | Rows 02412 | Rows 08640 | Sys-days | First | Last | Relays | Label: top debug-text template (share) | Source file |
|---|---|---|---|---|---|---|---|---|---|---|
| 1200019 | RTA | DO | 11418 | 0 | 12 | 2026-05-19 | 2026-10-21 |  | [Apollo_Camera::_OffsetFactoryTask] mean value for offset [#, #] = #, is outside [#-#] limits ! (98%) | apollo_camera.cpp |
| 600104 | RTA | AR | 578 | 12 | 41 | 2026-05-01 | 2026-10-25 |  | Collimator CAN communication failure [####] (54%) | XRPAtlasLogger.cpp |
| 600105 | RTA | IH | 469 | 3 | 11 | 2026-05-27 | 2026-10-01 |  | [XRbeamForm::deviceConnectStatus] Positioner link disconnected (45%) | XRPAtlasLogger.cpp |
| 1000025 | RTA | IH | 425 | 5 | 11 | 2026-05-27 | 2026-10-01 | 203 | Arcnet failure (64%) | XRPAtlasLogger.cpp |
| 600501 | RTA | IH | 289 | 2 | 12 | 2026-05-27 | 2026-10-16 |  | Collimator Power Failure [####] (53%) | XRPAtlasLogger.cpp |
| 1050686 | POS | DO | 144 | 0 | 7 | 2026-05-22 | 2026-10-01 | 142 | ATLAS SUPERVISOR: RTAC connection timed out. (100%) | atlas_cmd_interpreter.c |
| 3400037 | RTA | IH | 89 | 9 | 37 | 2026-05-01 | 2026-10-22 |  | User has requested Shutdown. (100%) | XRSysMgr.cpp |

## 5. Counted in `cv.error` only

174 codes, 13,245 counted rows.

| Code | Sub | Cat | Rows 02412 | Rows 08640 | Sys-days | First | Last | Relays | Label: top debug-text template (share) | Source file |
|---|---|---|---|---|---|---|---|---|---|---|
| 1050171 | POS | DO | 5274 | 3 | 10 | 2026-05-27 | 2026-09-18 | 678 | ******* Colimator : set Auto ******** (27%) | lcsend.c |
| 3000015 | RTA | DO | 672 | 48 | 39 | 2026-05-01 | 2026-10-25 |  | [XRSubsysMgrRTAC::startSCTservice] from Actor: XRImChainPos Component: Smart Handle/Box FW (36%) | XRPAtlasLogger.cpp |
| 2800006 | DL | AR | 543 | 123 | 8 | 2026-05-01 | 2026-09-22 |  | *(no readable text)* | XRSubsysMgrDLImpl.cxx |
| 1000014 | RTA | IH | 410 | 3 | 12 | 2026-05-27 | 2026-10-16 | 188 | SID out of range (99%) | XRPAtlasLogger.cpp |
| 1050088 | POS | WR | 271 | 102 | 130 | 2026-05-01 | 2026-11-05 | 275 | RELAY_K#, open (49%) | validation_task.c |
| 1050233 | POS | WR | 349 | 0 | 11 | 2026-05-27 | 2026-10-16 | 82 | SMA/MCB board Initialization failure (PRD Failed) (24%) | geometry_task.c |
| 1050167 | POS | DO | 242 | 5 | 48 | 2026-05-01 | 2026-11-03 | 225 | COLLISION SENSOR ACTIVATED. CLEAR AND TRY AGAIN (#). (100%) | saf_safetytask.c |
| 3602010 | RTA | IH | 209 | 24 | 39 | 2026-05-01 | 2026-10-25 |  | [XRTechMgr::initActor] don't allow the acquisition until the generator is powered up during boot (48%) | XRTechMgr |
| 600502 | RTA | DO | 219 | 13 | 41 | 2026-05-01 | 2026-10-25 |  | Collimator power supply recovered [####] (100%) | XRPAtlasLogger.cpp |
| 1000101 | RTA | AR | 196 | 6 | 9 | 2026-08-14 | 2026-10-01 |  | [XRImChainPos::logTifError] code=# debugText=(GebDriver local error code = # , error number = #) (100%) | XRPAtlasLogger.cpp |
| 5000020 | DL | DO | 169 | 15 | 8 | 2026-05-01 | 2026-09-22 |  | XRUserIfDL::COMM_ERROR_# :: ERROR: Publishing Event on Local Actor (72%) | GenericActor.cpp |
| 4210026 | RTA | IH | 169 | 0 | 5 | 2026-09-14 | 2026-09-18 |  | [XRUserIf::_sendPatientContouringCommandToPOS] Acknowledge for patient Contouring command not received or inco (95%) | XRPAtlasLogger.cpp |
| 1000028 | RTA | DO | 164 | 0 | 5 | 2026-09-14 | 2026-09-18 |  | [XRImChainPos::_syncDetectorSizeAck] timed-out waiting for DetectorSizeAck (95%) | XRPAtlasLogger.cpp |
| 1050001 | POS | DO | 72 | 89 | 90 | 2026-05-01 | 2026-11-08 | 157 | disableFromBuddyN (93%) | motion_control_task.c |
| 200205 | RTA | DO | 138 | 16 | 14 | 2026-05-19 | 2026-10-28 |  | [XRAcqSync] Unexpected Event STOP_EXPOSURE_TRIGGER_DONE eventId # Received while in State ACTOR_SEQUENCES__ACQ (42%) | XRPAtlasLogger.cpp |
| 810012 | DL | DO | 77 | 73 | 4 | 2026-06-22 | 2026-10-22 |  | Last Image Id received twice (99%) | DLGenericActorContext.cxx |
| 600402 | RTA | DO | 147 | 0 | 6 | 2026-09-14 | 2026-09-21 |  | [XRbeamForm::notActSpectralFilter] Spectral Filter Mismatch in state SF_IDLE # instead of # (85%) | XRPAtlasLogger.cpp |
| 1050259 | POS | WR | 128 | 1 | 9 | 2026-08-28 | 2026-09-21 | 114 | OMEGA#/# -- motorization licensed asked by System, BUT stepper not available (88%) | table_geometry_task.c |
| 1050003 | POS | DO | 79 | 37 | 59 | 2026-05-01 | 2026-11-08 | 116 | disableFromBuddyN (100%) | motion_control_task.c |
| 1050155 | POS | WR | 110 | 3 | 15 | 2026-05-27 | 2026-10-22 | 79 | POS : COMMUNICATION ERROR WITH CAPACITIVE SENSORS BOARD during watchdog (#). (50%) | cap_sensors_task.c |
| 1050181 | POS | DO | 112 | 0 | 54 | 2026-05-04 | 2026-11-04 | 94 | Table: Over current error. Hard over current. Motion halted. (T:#x# H:#x# U:#x#). (100%) | saf_motionerrors.c |
| 200055 | RTA | WR | 76 | 35 | 41 | 2026-05-05 | 2026-11-04 |  | [XRAcqSync::expDeviceStatus] Expose Switch pressed while abort is forced (36%) | XRPAtlasLogger.cpp |
| 1050002 | POS | DO | 74 | 35 | 50 | 2026-05-01 | 2026-11-06 | 103 | disableFromBuddyN (87%) | motion_control_task.c |
| 1050004 | POS | DO | 52 | 50 | 60 | 2026-05-01 | 2026-11-05 | 99 | disableFromBuddyN (97%) | motion_control_task.c |
| 4810012 | DL | DO | 77 | 21 | 10 | 2026-05-19 | 2026-11-03 |  | Last Image Id received twice (94%) | DLGenericActorContext.cxx |
| 1050261 | POS | WR | 98 | 0 | 8 | 2026-06-08 | 2026-09-21 | 90 | mcbLimitSwitch (65%) | motion_control_task.c |
| 1050263 | POS | WR | 98 | 0 | 10 | 2026-06-08 | 2026-09-21 | 87 | mcbLimitSwitch (67%) | motion_control_task.c |
| 1050262 | POS | WR | 94 | 0 | 8 | 2026-07-24 | 2026-09-21 | 87 | mcbLimitSwitch (76%) | motion_control_task.c |
| 1610012 | DL | DO | 73 | 19 | 4 | 2026-06-22 | 2026-10-22 |  | Last Image Id received twice (100%) | DLGenericActorContext.cxx |
| 1050260 | POS | WR | 84 | 0 | 7 | 2026-07-24 | 2026-09-18 | 78 | mcbLimitSwitch (73%) | motion_control_task.c |
| 3800105 | RTA | DO | 78 | 4 | 4 | 2026-06-22 | 2026-10-22 |  | null frameTime (68%) | XRPAtlasLogger.cpp |
| 1050156 | POS | WR | 73 | 2 | 15 | 2026-05-01 | 2026-10-22 | 62 | Capacitive sensors board failure : #x# (#) (81%) | cap_sensors_task.c |
| 2810001 | DL | WR | 7 | 67 | 57 | 2026-05-05 | 2026-11-08 |  | Communication error between DL and InnovaCentral Touch screen (55%) | MySocketEventHandler.cxx |
| 1050055 | POS | WR | 48 | 25 | 36 | 2026-05-01 | 2026-11-08 | 71 | vinputNotDetected (85%) | motion_control_task.c |
| 1050278 | POS | DO | 68 | 1 | 7 | 2026-08-28 | 2026-09-18 | 36 | Stepping board PRD no response (97%) | table_geometry_task.c |
| 1050016 | POS | WR | 31 | 30 | 40 | 2026-05-04 | 2026-11-05 | 59 | vinputNotDetected (82%) | motion_control_task.c |
| 600204 | RTA | AR | 49 | 9 | 21 | 2026-05-14 | 2026-10-16 |  | [XRbeamForm::_fovRegulatory] BeamForm BeamCoverage feedback out of range (100%) | XRPAtlasLogger.cpp |
| 600202 | RTA | DO | 49 | 9 | 21 | 2026-05-14 | 2026-10-16 |  | [XRbeamForm::_fovRegulatory] FOV_OUT_OF_RANGE Recovering Retry (100%) | XRPAtlasLogger.cpp |
| 1050025 | POS | DO | 55 | 0 | 6 | 2026-09-11 | 2026-09-18 | 42 | SMA/MCB board PRD no response (96%) | geometry_task.c |
| 1050026 | POS | DO | 52 | 0 | 6 | 2026-09-11 | 2026-09-18 | 36 | SMA/MCB board PRD no response (96%) | geometry_task.c |
| 1050028 | POS | DO | 52 | 0 | 6 | 2026-09-11 | 2026-09-18 | 32 | SMA/MCB board PRD no response (92%) | geometry_task.c |
| 3800602 | RTA | DO | 39 | 11 | 20 | 2026-05-07 | 2026-10-06 |  | Coh.Chk during DSA acq changed: (LONG from # to #) (52%) | XRPAtlasLogger.cpp |
| 1050081 | POS | WR | 41 | 6 | 31 | 2026-05-01 | 2026-10-22 |  | PIB: #V kernel PRD failed (100%) | pib_task.c |
| 1050042 | POS | WR | 24 | 23 | 30 | 2026-05-04 | 2026-11-05 | 45 | vinputNotDetected (81%) | motion_control_task.c |
| 1050027 | POS | DO | 46 | 0 | 6 | 2026-09-11 | 2026-09-18 | 33 | SMA/MCB board PRD no response (96%) | geometry_task.c |
| 1050255 | POS | WR | 39 | 0 | 5 | 2026-09-11 | 2026-09-18 | 18 | SMA/MCB board PRD is FAILED (100%) | geometry_task.c |
| 410011 | RTA | WR | 37 | 0 | 12 | 2026-05-19 | 2026-10-21 |  | Battery loading (51%) | XRPAtlasLogger.cpp |
| 1050257 | POS | WR | 36 | 0 | 4 | 2026-09-11 | 2026-09-18 | 20 | SMA/MCB board PRD is FAILED (100%) | geometry_task.c |
| 1050258 | POS | WR | 35 | 0 | 5 | 2026-09-11 | 2026-09-18 | 12 | SMA/MCB board PRD is FAILED (100%) | geometry_task.c |
| 1050252 | POS | WR | 22 | 12 | 14 | 2026-05-01 | 2026-10-29 | 18 | lock button pressed on SH/SB (100%) | newsmarthandlelayer.c |
| 410001 | RTA | AR | 34 | 0 | 10 | 2026-05-12 | 2026-10-10 |  | *(no readable text)* | XRPAtlasLogger.cpp |
| 410005 | RTA | WR | 34 | 0 | 10 | 2026-05-12 | 2026-10-10 |  | *(no readable text)* | XRPAtlasLogger.cpp |
| 1050256 | POS | WR | 34 | 0 | 4 | 2026-09-11 | 2026-09-18 | 15 | SMA/MCB board PRD is FAILED (100%) | geometry_task.c |
| 3800319 | RTA | DO | 19 | 14 | 22 | 2026-05-05 | 2026-11-03 |  | *(no readable text)* | XRPAtlasLogger.cpp |
| 1050103 | POS | WR | 17 | 13 | 19 | 2026-05-01 | 2026-10-27 | 28 | vinputNotDetected (70%) | motion_control_task.c |
| 4200071 | RTA | IH | 10 | 20 | 15 | 2026-05-08 | 2026-10-16 |  | Problem of Exposure Redundancy just after pedal push (50%) | XRPAtlasLogger.cpp |
| 2200105 | RTA | DO | 25 | 1 | 4 | 2026-06-22 | 2026-10-22 |  | [XRPatPos] Unexpected Event STOP_EXPOSURE_TRIGGER_DONE eventId # Received while in State ACTOR_SEQUENCES__CONF (100%) | XRPAtlasLogger.cpp |
| 2400105 | RTA | DO | 25 | 1 | 4 | 2026-06-22 | 2026-10-22 |  | [XRPeriDevCtrl] Unexpected Event STOP_EXPOSURE_TRIGGER_DONE eventId # Received while in State ACTOR_SEQUENCES_ (100%) | XRPAtlasLogger.cpp |
| 1000105 | RTA | DO | 25 | 1 | 4 | 2026-06-22 | 2026-10-22 |  | [XRImChainPos] Unexpected Event STOP_EXPOSURE_TRIGGER_DONE eventId # Received while in State ACTOR_SEQUENCES__ (100%) | XRPAtlasLogger.cpp |
| 1200104 | RTA | IH | 25 | 0 | 7 | 2026-05-19 | 2026-10-21 |  | [DemSupervisor::_PWSStatusDebugMessage] Statuses are bad : (PG#B : OK) (PG#A : OK) (PG#B : OK) (PG# : #) (PG#A (48%) | DemSupervisor.cpp |
| 3602005 | RTA | DO | 21 | 2 | 5 | 2026-06-22 | 2026-10-22 |  | [XRTechMgr] Unexpected Event STOP_EXPOSURE_TRIGGER_DONE eventId # Received while in State ACTOR_SEQUENCES__CON (87%) | XRPAtlasLogger.cpp |
| 4200061 | RTA | DO | 14 | 7 | 16 | 2026-05-05 | 2026-10-27 |  | system not yet configured for a protocol. (100%) | XRPAtlasLogger.cpp |
| 1050243 | POS | WR | 9 | 12 | 19 | 2026-05-11 | 2026-10-15 | 21 | *(no readable text)* | saf_safetytask.c |
| 1050185 | POS | DO | 15 | 6 | 16 | 2026-06-03 | 2026-10-26 | 19 | Table: Longitudinal extra course switch engaged (T:#x# H:#x# U:#). (100%) | saf_motionerrors.c |
| 3200024 | DL | DO | 16 | 5 | 4 | 2026-05-08 | 2026-10-14 |  | *(no readable text)* | XRSvcMgr.h |
| 200201 | RTA | AR | 21 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | [XRAcqSync::expDeviceStatus] the opMode # is not an active opMode (100%) | XRPAtlasLogger.cpp |
| 1050152 | POS | WR | 20 | 0 | 3 | 2026-09-15 | 2026-09-17 |  | Fluoro: foot or handle prep switch permanent valid (T:#x# H:# U:#). (100%) | validation_task.c |
| 1050169 | POS | WR | 18 | 1 | 8 | 2026-06-22 | 2026-10-22 | 13 | GRID UNLOCKED. LOCK OR REMOVED THE GRID (T:#). (100%) | saf_safetytask.c |
| 600205 | RTA | AR | 18 | 1 | 2 | 2026-08-28 | 2026-09-14 |  | Collimator SID out of range [####] (95%) | XRPAtlasLogger.cpp |
| 2800165 | DL | IH | 16 | 2 | 8 | 2026-05-01 | 2026-09-22 |  | Process runtime fatal error (100%) | SupProcess.cxx |
| 3800331 | RTA | DO | 3 | 14 | 8 | 2026-05-22 | 2026-10-01 |  | *(no readable text)* | XRPAtlasLogger.cpp |
| 2010001 | RTA | WR | 0 | 16 | 4 | 2026-06-08 | 2026-09-28 |  | system is up for more than # days (100%) | XRPAtlasLogger.cpp |
| 1050082 | POS | WR | 8 | 6 | 13 | 2026-05-22 | 2026-11-05 | 14 | PIB: #V table PRD failed (100%) | pib_task.c |
| 3602083 | RTA | DO | 2 | 12 | 11 | 2026-05-08 | 2026-10-25 |  | JEDI Error Code: #H chiller ser com error Data Related to Error: # Tube # #: OK, Tube #: Set, Rotor Thermal Er (64%) | XRPAtlasLogger.cpp |
| 1050047 | POS | DO | 0 | 14 | 11 | 2026-05-04 | 2026-10-20 | 14 | buddyEncoderOverSpeed (100%) | motion_control_task.c |
| 1050305 | POS | WR | 6 | 7 | 12 | 2026-05-08 | 2026-09-29 | 13 | TUBE COLLISION NOT CLEARED. CONTINUE WITH CAUTION (T:#). In MP_SetCollisionNotClearedMsgOnIRM (100%) | saf_safetytask.c |
| 1200007 | RTA | AR | 12 | 0 | 3 | 2026-08-14 | 2026-10-22 |  | [CalibrationScenario::processApplicationMessageDisplayChanged] This method needs to be implemented for this ca (50%) | calibrationscenario.cpp |
| 600901 | RTA | DO | 12 | 0 | 6 | 2026-09-14 | 2026-09-21 |  | [XRbeamForm::timerExpiredAutocal], AutoCal done upon timer expired ... (100%) | XRPAtlasLogger.cpp |
| 1050178 | POS | WR | 6 | 5 | 10 | 2026-05-08 | 2026-10-19 | 10 | DETECTOR COLLISION NOT CLEARED. CONTINUE WITH CAUTION (T:#). In MP_SetCollisionNotClearedMsgOnIRM (100%) | saf_safetytask.c |
| 1050050 | POS | DO | 7 | 4 | 11 | 2026-05-18 | 2026-09-29 | 11 | backEmf (100%) | motion_control_task.c |
| 600101 | RTA | IH | 11 | 0 | 5 | 2026-09-14 | 2026-09-21 |  | [XRbeamForm::timerExpiredBoot] Positioner link timeout, EIMRA not received (91%) | XRPAtlasLogger.cpp |
| 3602087 | RTA | DO | 3 | 7 | 8 | 2026-05-22 | 2026-10-01 |  | Anode: # Cathode: # Anode+Cathode: # kV reg on steady state: # kV reg on kV rise: # (100%) | XRTechMgr.cpp |
| 2800060 | DL | IH | 8 | 1 | 8 | 2026-05-01 | 2026-09-22 |  | component startup timeout (100%) | SupProcess.cxx |
| 4800010 | DL | WR | 8 | 1 | 8 | 2026-05-01 | 2026-09-22 |  | Language could not be retrieved error @ TranslationWrapper.cxx # (100%) | LoggerImpl.h |
| 2800066 | DL | IH | 8 | 1 | 8 | 2026-05-01 | 2026-09-22 |  | Application initialization fatal error. Call Service (100%) | Supervisor.cxx |
| 1050224 | POS | WR | 3 | 6 | 7 | 2026-05-13 | 2026-10-08 | 7 | Autopos joystick failure (56%) | newtssclayer.c |
| 410012 | RTA | DO | 9 | 0 | 7 | 2026-05-19 | 2026-10-20 |  | *(no readable text)* | XRPAtlasLogger.cpp |
| 1050154 | POS | WR | 3 | 6 | 9 | 2026-05-27 | 2026-11-05 | 10 | CS electrod problem ## (100%) | cap_sensors_task.c |
| 2800059 | DL | IH | 7 | 1 | 7 | 2026-05-01 | 2026-09-18 |  | component startup timeout (100%) | SupProcess.cxx |
| 2800061 | DL | IH | 7 | 1 | 7 | 2026-05-01 | 2026-09-18 |  | component startup timeout (100%) | SupProcess.cxx |
| 3602019 | RTA | DO | 3 | 5 | 7 | 2026-05-22 | 2026-10-01 |  | [XRTechMgr::notifyGeneratorFinalExposureParameters] numberOfTubeSpits=# below the maxNumberOfTubeSpits=# after (100%) | XRTechMgr.cpp |
| 4800011 | DL | IH | 5 | 2 | 6 | 2026-05-27 | 2026-10-20 |  | Failed to update status on console error @ StatusUDPListener.cxx # (86%) | LoggerImpl.h |
| 4210022 | RTA | DO | 7 | 0 | 6 | 2026-09-21 | 2026-10-21 |  | [XRUserIf::timerExpired] STORAGE_REQUEST_STATUS has not been received in time. timerId: # (100%) | XRPAtlasLogger.cpp |
| 3000014 | RTA | DO | 6 | 0 | 3 | 2026-06-22 | 2026-09-18 |  | [PerfMonitoringMgr::handlePerfMonitoringMsg] timer expired for action APPSETUP_CLEAR_OPMODES_CONFIG (67%) | XRPAtlasLogger.cpp |
| 1050223 | POS | WR | 2 | 4 | 4 | 2026-05-18 | 2026-10-02 | 6 | Contour filter joystick failure (100%) | newtssclayer.c |
| 2000100 | RTA | DO | 4 | 2 | 3 | 2026-08-14 | 2026-10-22 |  | [PpdManagementProperty::checkFrameLost] opmode = # ppd.frameId = #, lastFrameId = # (100%) | XRPAtlasLogger.cpp |
| 2800033 | DL | DO | 6 | 0 | 3 | 2026-08-14 | 2026-11-04 |  | *(no readable text)* | Browser.cxx |
| 1050138 | POS | DO | 6 | 0 | 4 | 2026-09-11 | 2026-09-15 | 6 | POSITION MISMATCH BETWEEN REAL AND VIRTUAL POSITIONERS (T:#x# H:# U:#) error position on axis ffffffff. (100%) | anticol_task.c |
| 1010002 | RTA | DO | 6 | 0 | 4 | 2026-09-15 | 2026-09-18 |  | [XRImChainPos::resetSendAngles] timed-out waiting sendAngleAck (100%) | XRPAtlasLogger.cpp |
| 4210025 | RTA | DO | 6 | 0 | 4 | 2026-09-15 | 2026-09-18 |  | [XRUserIf::_resetSendAngle] resetSendangleStatus is # (100%) | XRPAtlasLogger.cpp |
| 1050277 | POS | WR | 4 | 1 | 3 | 2026-05-07 | 2026-10-02 | 3 | Table/Gantry lock failure (100%) | newsmarthandlelayer.c |
| 3200008 | DL | WR | 1 | 4 | 2 | 2026-06-22 | 2026-08-28 |  | creation of a new Calibration - system already In Calibration (100%) | XRSvcMgr.h |
| 1050015 | POS | DO | 5 | 0 | 3 | 2026-07-01 | 2026-09-21 | 5 | potentiometerEncoderMismatch (100%) | motion_control_task.c |
| 3200025 | DL | DO | 5 | 0 | 1 | 2026-08-14 | 2026-08-14 |  | *(no readable text)* | XRSvcMgr.h |
| 2800005 | DL | AR | 5 | 0 | 4 | 2026-09-14 | 2026-10-20 |  | *(no readable text)* | XRSubsysMgrDLImpl.cxx |
| 1200204 | RTA | AR | 3 | 1 | 4 | 2026-05-07 | 2026-10-20 |  | [ImageAcquisitionMonitoring] # missing x-ray pulses in # msecs (100%) | img_acq_monitoring.cpp |
| 3010001 | RTA | WR | 3 | 1 | 4 | 2026-06-22 | 2026-10-22 |  | [RTACMemoryMonitor] RTAC Memory usage reached # percent of the pool size (100%) | XRPAtlasLogger.cpp |
| 1210001 | RTA | WR | 4 | 0 | 2 | 2026-06-30 | 2026-10-20 |  | [DemSupervisor::_PWSStatusDebugMessage] Statuses are bad : (PG#B : OK) (PG#A : OK) (PG#B : OK) (PG# : #) (PG#A (50%) | DemSupervisor.cpp |
| 3800604 | RTA | WR | 2 | 2 | 2 | 2026-08-13 | 2026-09-08 |  | SFB=#.#, TED=#.#, Threshold=# (50%) | XRPAtlasLogger.cpp |
| 1050306 | POS | WR | 4 | 0 | 1 | 2026-09-14 | 2026-09-14 | 1 | TUBE COLLISION DETECTION PROBLEM during MP_DiagnosticBumpers (T:#x# H:#x# U:#x#) (100%) | saf_safetytask.c |
| 1050148 | POS | DO | 4 | 0 | 1 | 2026-09-14 | 2026-09-14 |  | MCB PRD Failure due to undefined reason (MCB PRD value #x# on axis #) (100%) | prd_task.c |
| 1050137 | POS | WR | 4 | 0 | 3 | 2026-09-15 | 2026-09-17 |  | Lift brake command failure. Please call service (#). (100%) | pib_task.c |
| 1050159 | POS | DO | 4 | 0 | 3 | 2026-09-16 | 2026-09-18 | 1 | I/O DRIVER FAILED (T:# HW:# & US:#), task MP_ASC_Inj_Stat_Update : injector status error (75%) | injector_task.c |
| 400015 | RTA | DO | 4 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | CLEARING waiting for XRImDet (100%) | AppDirSM.cpp |
| 4200067 | RTA | IH | 4 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | [XRUserIf::protocolConfigDone] protocolConfigDone called with bad status (100%) | XRPAtlasLogger.cpp |
| 0 | DL | AR | 2 | 1 | 3 | 2026-05-13 | 2026-10-06 |  | Failed to store fluoro in DataBase and to delete from IP Disk (100%) | XRDataMgrImpl.cxx |
| 2800077 | DL | WR | 3 | 0 | 2 | 2026-05-27 | 2026-10-01 |  | Ethernet link to RTAC has been lost (67%) | LinkMonitorWrapper.cxx |
| 5000009 | DL/RTA | DO | 3 | 0 | 3 | 2026-05-27 | 2026-09-17 |  | Unexpected event startBootPhase received while in BOOT (67%) | BootAdapter.cpp |
| 200207 | RTA | DO | 3 | 0 | 2 | 2026-08-14 | 2026-09-16 |  | [SystemStatusForXrayProperty::_retrieveStatusReadyForXRay] opModeId # not in the opModeId list (67%) | XRPAtlasLogger.cpp |
| 2800027 | DL | DO | 1 | 2 | 3 | 2026-07-03 | 2026-09-23 |  | JobID: #, unexpected disconnection (100%) | DJRNWLogger.cxx |
| 1050139 | POS | DO | 3 | 0 | 3 | 2026-09-11 | 2026-09-18 | 3 | POSITION MISMATCH BETWEEN REAL AND VIRTUAL POSITIONERS (T:#x# H:# U:#) error position on axis ffffffff. (67%) | anticol_task.c |
| 3800333 | RTA | WR | 3 | 0 | 1 | 2026-09-14 | 2026-09-14 |  | *(no readable text)* | XRPAtlasLogger.cpp |
| 1050102 | POS | DO | 3 | 0 | 3 | 2026-09-14 | 2026-10-01 | 3 | potentiometerEncoderMismatch (100%) | motion_control_task.c |
| 600302 | RTA | WR | 3 | 0 | 2 | 2026-09-15 | 2026-09-17 |  | [XRbeamForm::timerExpiredBoot] Contour Filter not booted (100%) | XRPAtlasLogger.cpp |
| 4202002 | RTA | WR | 3 | 0 | 3 | 2026-09-15 | 2026-09-17 |  | [XRUserIf::appDisableSpinInPos] timed-out waiting spinEnableDisableAck (100%) | XRPAtlasLogger.cpp |
| 1800007 | RTA | AR | 3 | 0 | 2 | 2026-09-16 | 2026-09-17 |  | [DigAbd_fpga_Driver::waitForReply] timed out, waiting for message IPMODE_ACQUISITION (33%) | dig_abd_driver.cpp |
| 3602068 | RTA | WR | 2 | 1 | 3 | 2026-08-28 | 2026-09-18 |  | JEDI Error Code: #H chiller problem # minutes Data Related to Error: # Tube # #: OK, Tube #: Set, Rotor Therma (100%) | XRPAtlasLogger.cpp |
| 3610001 | RTA | DO | 2 | 1 | 3 | 2026-08-28 | 2026-09-18 |  | [JediInterface::_handleGeneratorDelayedTriggerStopCmdInNominalSequence] TRIGGER_STOP_CMD arrived (100%) | XRTechMgr.cpp |
| 3602045 | RTA | IH | 2 | 1 | 3 | 2026-08-28 | 2026-09-18 |  | JEDI Error Code: #H Inverter Gate Power Supply error Data Related to Error: # Tube # #: OK, Tube #: Set, Rotor (100%) | XRPAtlasLogger.cpp |
| 1800019 | RTA | DO | 1 | 1 | 2 | 2026-06-19 | 2026-10-15 |  | [DigAbd::computeSmartAbd] validSmartABD:FALSE, frameID:#, UI.validity:#, UI.frameID:#, SE.validity:#, SE.frame (100%) | dig_abd.cpp |
| 5000047 | RTA | DO | 2 | 0 | 2 | 2026-06-22 | 2026-09-18 |  | ActorsNot ready : , XRSubsysMgrRTAC (50%) | SysBootAdapter.cpp |
| 3400027 | RTA | IH | 2 | 0 | 2 | 2026-06-22 | 2026-09-18 |  | Timeout during boot process (100%) | XRSysMgr.cpp |
| 5000011 | RTA | IH | 2 | 0 | 2 | 2026-06-22 | 2026-09-18 |  | ActorsNot ready : , XRImDet (50%) | BootAdapter.cpp |
| 3000001 | RTA | DO | 2 | 0 | 2 | 2026-06-22 | 2026-09-18 |  | [XRSubsysMgrRTAC::userTimeoutBoot] Level = # Phase = # (100%) | XRPAtlasLogger.cpp |
| 3602012 | RTA | AR | 2 | 0 | 1 | 2026-06-30 | 2026-06-30 |  | [JediDriver::reportError] Error code=#, sourceLine=#, sourceFile=../ESDCanOpenDriver.cpp, debugText=ReadSDO fa (100%) | XRTechMgr.cpp |
| 3602047 | RTA | IH | 2 | 0 | 1 | 2026-08-14 | 2026-08-14 |  | JEDI Error Code: #H # bus out of range Data Related to Error: # Tube # #: OK, Tube #: Set, Rotor Thermal Error (50%) | XRPAtlasLogger.cpp |
| 1050056 | POS | WR | 2 | 0 | 2 | 2026-09-12 | 2026-09-18 |  | Problem on K#_cmd_input not open (prd: #) (100%) | prd_task.c |
| 1400007 | RTA | AR | 2 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | [Preprocessing_fpga_Driver::waitForReply] timed out waiting for message IPMODE_ACQUISITION~~ (50%) | preprocessing_driver.cpp |
| 200013 | RTA | AR | 2 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | [XRAcqSync::_handleASTimeout] START_PREP phase waiting for actors: XRTechOpt XRTechMgr XRImProc XRDataMgr (50%) | XRPAtlasLogger.cpp |
| 3602001 | RTA | AR | 2 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | [XRTechMgr::clearAcquisitionPhase] failed to clear the properties for STOP_PREP acquisition phase (100%) | XRPAtlasLogger.cpp |
| 810017 | DL | DO | 2 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | StartPrepare NOT done due to: PixelPitch - not yet consolidated (100%) | DLGenericActorContext.cxx |
| 1610017 | DL | DO | 2 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | StartPrepare NOT done due to: PixelPitch - not yet consolidated (100%) | DLGenericActorContext.cxx |
| 4202004 | RTA | AR | 2 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | [XRUserIf::_uponFovChanged] failed to call _xrExpSensPtr->setSensorROI(): CORBA::Exception (100%) | XRPAtlasLogger.cpp |
| 1800205 | RTA | AR | 2 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | [SensorROIProperty::PropertyCheck] Unable to find circular ROI (100%) | sensor_roi.cpp |
| 3602051 | RTA | IH | 1 | 1 | 2 | 2026-08-28 | 2026-09-16 |  | JEDI Error Code: #H tube cooling supply error Data Related to Error: # Tube # #: OK, Tube #: Set, Rotor Therma (100%) | XRPAtlasLogger.cpp |
| 2400015 | RTA | AR | 2 | 0 | 1 | 2026-09-18 | 2026-09-18 |  | Unexpected injection, please release X-ray switches (100%) | XRPAtlasLogger.cpp |
| 2400019 | RTA | WR | 2 | 0 | 1 | 2026-09-18 | 2026-09-18 |  | Issue while stopping injection, please release X-ray switches (50%) | XRPAtlasLogger.cpp |
| 3602086 | RTA | DO | 2 | 0 | 2 | 2026-10-01 | 2026-10-05 |  | JEDI Error Code: #H LVPS#: Recovery from power int Data Related to Error: # Tube # #: OK, Tube #: OK, Rotor Th (100%) | XRPAtlasLogger.cpp |
| 1050095 | POS | DO | 1 | 1 | 2 | 2026-06-03 | 2026-10-06 | 2 | servoloopsCheckVelocity (50%) | motion_control_task.c |
| 1050179 | POS | WR | 1 | 1 | 2 | 2026-05-06 | 2026-10-15 | 2 | EMERGENCY STOP OCCURRED. PRESS RESET UNDER TSSC TO CONTINUE (#) (100%) | saf_safetytask.c |
| 2800020 | DL | AR | 0 | 2 | 1 | 2026-05-02 | 2026-05-02 |  | TimeOut detected by the Reliable Image Frozen Detection (100%) | DisplayOp.c |
| 1050222 | POS | WR | 0 | 2 | 2 | 2026-05-18 | 2026-09-01 | 2 | Collimator joystick failure (100%) | newtssclayer.c |
| 3602016 | RTA | DO | 0 | 2 | 2 | 2026-09-18 | 2026-10-01 |  | [XRTechMgr::notifyGeneratorFinalExposureParameters] numberOfTubeSpits=# above the maxNumberOfTubeSpits=# after (100%) | XRTechMgr.cpp |
| 3602036 | RTA | AR | 0 | 2 | 1 | 2026-10-01 | 2026-10-01 |  | JEDI Error Code: #H ILR max current detected Data Related to Error: # Tube # #: OK, Tube #: Set, Rotor Thermal (50%) | XRPAtlasLogger.cpp |
| 1050195 | POS | WR | 1 | 0 | 1 | 2026-05-14 | 2026-05-14 | 1 | Permanent valid on small table joystick failure (100%) | newsmarthandlelayer.c |
| 1200101 | RTA | DO | 1 | 0 | 1 | 2026-06-22 | 2026-06-22 |  | [DemSupervisor::_handleConditionerCommunication] Link between IDC and the conditioner is down (100%) | DemSupervisor.cpp |
| 1200112 | RTA | DO | 1 | 0 | 1 | 2026-06-22 | 2026-06-22 |  | [DemSupervisor::_bootConditioner] The link with the conditioner is down (Retry number: #) (100%) | DemSupervisor.cpp |
| 1200107 | RTA | IH | 1 | 0 | 1 | 2026-06-22 | 2026-06-22 |  | [DemSupervisor::_bootConditioner] Failed to boot the conditioner~~ (100%) | DemSupervisor.cpp |
| 1400206 | RTA | AR | 1 | 0 | 1 | 2026-07-15 | 2026-07-15 |  | [ImageAcquisitionMonitoring::IdcDlLink#Check] No answer from XRImProc for frame id # (100%) | img_acq_monitoring.cpp |
| 1050064 | POS | WR | 1 | 0 | 1 | 2026-08-27 | 2026-08-27 | 1 | Room light button failure (100%) | newtssclayer.c |
| 1050140 | POS | DO | 1 | 0 | 1 | 2026-09-14 | 2026-09-14 | 2 | POSITION MISMATCH BETWEEN REAL AND VIRTUAL POSITIONERS (T:#x# H:# U:#) error position on axis #. (100%) | anticol_task.c |
| 610002 | RTA | IH | 1 | 0 | 1 | 2026-09-15 | 2026-09-15 |  | Wrong collimator device: Angio detected instead of unknown [#A####] (100%) | XRPAtlasLogger.cpp |
| 400006 | RTA | DO | 1 | 0 | 1 | 2026-09-16 | 2026-09-16 |  | AD_START_PROTOCOL_CONFIG received while in CLEARING (100%) | AppDirSM.cpp |
| 1050196 | POS | WR | 1 | 0 | 1 | 2026-09-16 | 2026-09-16 | 1 | Permanent valid on lift joystick failure (100%) | newsmarthandlelayer.c |
| 1050308 | POS | WR | 1 | 0 | 1 | 2026-09-17 | 2026-09-17 | 1 | Patient contouring is enabled. (100%) | geometry_task.c |
| 1050194 | POS | WR | 1 | 0 | 1 | 2026-09-17 | 2026-09-17 | 1 | Permanent valid on Pivot/C-arc joystick failure (100%) | newsmarthandlelayer.c |
| 1050057 | POS | WR | 1 | 0 | 1 | 2026-09-21 | 2026-09-21 | 1 | cmdK#On (100%) | motion_control_task.c |
| 2800018 | DL | IH | 1 | 0 | 1 | 2026-09-22 | 2026-09-22 |  | Loging to Atlas... (100%) | XRSubsysMgrDLImpl.cxx |
| 1200001 | RTA | IH | 1 | 0 | 1 | 2026-10-20 | 2026-10-20 |  | [XRImDet::isExamStarted] Pointer to XRDataMgr is NULL! (100%) | xrimdet.cpp |
| 1600018 | DL | AR | 0 | 1 | 1 | 2026-05-02 | 2026-05-02 |  | <class ImpDisplayOp> (100%) | ImpOperator.cxx |
| 1600030 | DL | AR | 0 | 1 | 1 | 2026-05-02 | 2026-05-02 |  | *(no readable text)* | IpOpErrorHandlers.cxx |
| 1050048 | POS | DO | 0 | 1 | 1 | 2026-05-23 | 2026-05-23 | 1 | PWMError (100%) | motion_control_task.c |
| 4202007 | RTA | DO | 0 | 1 | 1 | 2026-07-09 | 2026-07-09 |  | [XRUserIf::timerExpired] unknown timerId: # (100%) | XRPAtlasLogger.cpp |
| 1200102 | RTA | DO | 0 | 1 | 1 | 2026-07-31 | 2026-07-31 |  | [DemSupervisor::_handleConditionerStatus] Alarms are raised : (Float Switch : #) (High Alarm : OK) (Low Alarm  (100%) | DemSupervisor.cpp |

## 6. Ignored: relay-only codes

These codes appear only as RTA relays (no original row), so they produce no fact.

1 codes, 0 counted rows.

| Code | Sub | Cat | Rows 02412 | Rows 08640 | Sys-days | First | Last | Relays | Label: top debug-text template (share) | Source file |
|---|---|---|---|---|---|---|---|---|---|---|
| 1050141 | — | — | 0 | 0 | 0 | — | — | 1 | *(no readable text)* | — |


## 7. Codes added after the inventory

Reviewed and added to `insight/cv/codes_reviewed.js`; each is counted in
`cv.error` only. Rows as of 2026-11-12 18:00 UTC (prod, read-only).

| Code | Sub | Cat | Rows 02412 | Rows 08640 | First (device) | Last (device) | Debug text | Source file | Added |
|---|---|---|---|---|---|---|---|---|---|
| 4800007 | DL | WR | 2 | 0 | 2026-11-12 10:21:45 | 2026-11-12 10:21:45 | Empty FOV List error @ UserProtocolController.cxx 933 | LoggerImpl.h | 2026-11-12 (CV-5) |
| 4800008 | DL | AR | 1 | 0 | 2026-11-12 10:22:16 | 2026-11-12 10:22:16 | CORBA::Exception: CORBA::NO_RESPONSE error @ UserProtocolController.cxx 694 | LoggerImpl.h | 2026-11-12 (CV-5) |

Both came in one minute on SME02412, between lift-collision and
collision-sensor messages (ids 474190–474197). They are the same family
as 4800010 / 4800011 (DL, `LoggerImpl.h`): software messages from the DL
host, with no hardware fault named. Not a named metric; watch only.
