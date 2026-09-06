import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG WM4000HWA front-load washer — matched on modelId "F3P2CYUBE__" (ThinQ2, deviceType 201, "TITAN27_BIG"
// panel per its modelJson; consumer model confirmed from the appliance plaque, serial 312TNZN1G525).
// Panel photo confirms: 12 dial courses (see COURSE) + a Downloaded slot, and 5 levels each on Temp/Spin/Soil. Same AABB frame family as the F3L2CYU__ sibling, but a LONGER record: 44 bytes led by a 0x2B
// marker (the sibling's is 25 bytes led by 0x18), so every offset below is this model's own.
//
// Frames are discriminated by buf[1] (buf[0] == 0x20 on every frame):
//   0xEC   status frame, 92-byte body: 3B header + 45B record A (previous state) + 44B record B (current).
//          We read record B at buf[48:]. Verified: record A is byte-identical to the previous frame's record B.
//   0xEB   single-record status frame, 47-byte body: the same 44-byte record at buf[3:]. Seen at (re)connect.
//   0xBD / 0xCD  full status dump / idle keepalive (~405-410 bytes) — not decoded.
//   0x31, 0x72, 0xD8, 0xE6, 0x00  serial / heartbeat / misc — not decoded.
//
// Field offsets are relative to the record's 0x2B marker (rec[0]). Every "confirmed" offset below was pinned
// against the LG cloud's own decoded washerDryer state (rethink-capture --cloud, bridge mode) or the LG ThinQ
// integration in Home Assistant at matching timestamps; "enum-consistent" offsets carry values that only make
// sense as the named modelJson enum and moved with the matching panel action, but have not yet been echoed by
// a cloud delta. Enum indices are the modelJson's MonitoringValue indices verbatim.
//
//   rec[2]   soilWash        enum-consistent (3 Normal -> 4 Normal-Heavy on a panel change)
//   rec[3]   temp            enum-consistent (16 Warm default -> 18 Hot -> 13 Tap Cold as the button was pressed)
//   Examined and deliberately NOT mapped (not user-facing features, characterized over a 124-frame capture):
//     rec[21] — single-frame transient (0x44 once, else 0x00); noise, not a field.
//     rec[25] — phase-progress sub-byte (0x07 selecting, 0x03 rinsing/spinning); redundant with `state`.
//     rec[41] — powered-on/settings-active flag (0x01 while a selection is live, 0x00 at Off/End).
//   rec[4]   rinse           CONFIRMED all 4 levels via a 0..3 extra-rinse sweep: 0E Normal,0F Plus,10 Plus2,11 Plus3
//   rec[28]  rinse count     CONFIRMED 1..4 (default 1 + extra); rec[40] bit 0x40 = extra-rinse flag (count>1)
//   rec[5]   spin            enum-consistent (0x0F = SPIN_HIGH, the Normal course default)
//   rec[6]   course code     the dial position; the modelJson course table has NO numeric ids, so names are
//                            filled in by observation (see COURSE). 0x2E is the course of the first capture.
//   rec[14:16] remainTime    hour, minute — CONFIRMED (cloud remainTimeMinute 17 -> 16 -> 15 -> 14 tracked byte 15)
//   rec[16:18] initialTime   hour, minute — CONFIRMED (0x28 = the 40-minute total HA reported for the cycle)
//   rec[19]  courseSpendPower CONFIRMED (cloud 48, 51, 61, 62 tracked byte 19 exactly); unit not documented
//   rec[22]  state           CONFIRMED (0x0B Running while HA said running, 0x0C Rinsing while HA said rinsing)
//   rec[23]  preState        CONFIRMED by the same transitions (0x03 Detecting -> 0x0B Running -> 0x0C Rinsing)
//   rec[28]  rinse count     enum-consistent (2 with extra rinse on, 1 after cloud reported rinseCount RINSE_1)
//   rec[29]  TCLCount        CONFIRMED (0x3B = 59 = HA's cycle counter)
//   rec[35]  options: bit 0x04 cold wash (CONFIRMED), bit 0x20 turbo wash (CONFIRMED on Speed Wash)
//   rec[36]  bit 0x10 steam (CONFIRMED). rec[38] bit 0x10 remote-start armed (CONFIRMED selecting; shared
//            with the running-state door lock). not yet located: door, door lock (standalone), child lock, delay/reserve time (rec[12:14] is the likely
//   slot, all-zero so far), error bits. Declared entities are omitted rather than
//   published wrong — the sibling's rule.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 92 // 3B header + 45B record A + 44B record B
const RECORD_B_OFFSET = 48

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 47 // 3B header + 44B record
const SINGLE_RECORD_OFFSET = 3

const RECORD_MARKER = 0x2b

const SOIL_OFFSET = 2
const TEMP_OFFSET = 3
const RINSE_OFFSET = 4
const SPIN_OFFSET = 5
const COURSE_OFFSET = 6
const REMAIN_HOUR_OFFSET = 14
const REMAIN_MIN_OFFSET = 15
const INITIAL_HOUR_OFFSET = 16
const INITIAL_MIN_OFFSET = 17
const RESERVE_HI_OFFSET = 12 // reserve (delay-wash) minutes, 16-bit big-endian at rec[12:14]; 0 unless armed
const RESERVE_LO_OFFSET = 13
const ENERGY_OFFSET = 19
const STATE_OFFSET = 22
const PRESTATE_OFFSET = 23
const RINSE_COUNT_OFFSET = 28 // TOTAL rinses (1=default .. 4=+3 extra); diagnostic. Extra Rinse is derived from
// rec[4] instead (0x0E none .. 0x11 +3), so it's the user's added-rinse count, not the course-inflated total.
const CYCLES_OFFSET = 29
const SIGNAL_OFFSET = 30 // panel "Signal" (end-of-cycle chime / button beeps). CONFIRMED via an off/on capture:
const SIGNAL_BIT = 0x04 // rec[30] 0x00 -> 0x04 as Signal was toggled on; symmetric in the previous-state record.
// rec[35] options byte (base 0x20). Cold Wash pinned live: 0x20->0x24 with cloud coldWash ON, and it forces
// temp to Cold + lengthens the estimate, matching the sibling. Other bits of this byte not yet isolated.
const OPTS35_OFFSET = 35
const OPT35_COLD_WASH = 0x04
// Turbo Wash pinned live on Speed Wash: rec[35] bit 0x20, 0x00<->0x20 tracking the cloud's turboWash. Also
// explains the Normal lock — on Normal this bit is permanently set (Turbo can't be turned off), so the
// sibling's "Turbo reads ON and can't be cycled on Normal" is the same effect, one byte over.
const OPT35_TURBO_WASH = 0x20
const OPT35_PRE_WASH = 0x40 // pinned live: rec[35] 0x20->0x60 with cloud preWash ON
// rec[36] bit 0x10 = steam, bit 0x20 = Rinse+Spin subcycle (temp/soil null while active). rec[37] bit 0x40 = FreshCare.
// rec[38] bit 0x10 = DOOR LOCK. It engaged when remote start was armed (the machine pre-locks the door so it
// can start unattended — user-confirmed) and it is also set throughout a running cycle. The cloud's
// remoteStart field tracks the arm event, but the physical bit is the lock, so that is what we publish.
const OPTS36_OFFSET = 36
const OPT36_STEAM = 0x10
const OPT36_RINSE_SPIN = 0x20 // pinned live: rec[36] bit 0x20 = Rinse+Spin subcycle active (a modifier on the
// selected course, not a course itself); while set, temp & soil report null (0x00) since it does not wash
const OPTS37_OFFSET = 37
const OPT37_FRESH_CARE = 0x40 // pinned live: rec[37] 0x00->0x40 with cloud freshCare ON
const OPTS38_OFFSET = 38
const OPT38_DOOR_LOCK = 0x10
const OPT38_CHILD_LOCK = 0x20 // pinned live: rec[38] 0x40->0x60 with cloud childLock ON (this model DOES expose it in-frame, unlike the F3L2CYU__ sibling)
const OPT38_REMOTE_START = 0x40 // rec[38] bit 0x40 = REMOTE START armed. Pinned by a same-machine diff: two
// selecting frames, remote start OFF vs ON, differed by EXACTLY this bit (rec[38] 0x10 -> 0x50). This is the bit
// earlier mistaken for a "door closed" sensor — there is NO door sensor; that mislabel is why "door" read
// nonsensically (open while shut/locked). A manual delay start locks the door (0x10 set) with 0x40 CLEAR,
// confirming 0x40 is remote-start, not the lock.

const STATE_OFF = 0x00

// modelJson MonitoringValue.state — indices verbatim, labels de-shouted.
const STATE: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Initial',
    0x02: 'Paused',
    0x03: 'Detecting',
    0x05: 'Add Drain',
    0x06: 'Detergent Amount',
    0x07: 'Reserved',
    0x09: 'Pre-wash',
    0x0b: 'Running',
    0x0c: 'Rinsing',
    0x0d: 'Rinse Hold',
    0x0e: 'Spinning',
    0x0f: 'Drying',
    0x10: 'End',
    0x15: 'Refreshing',
    0x17: 'Error Auto Off',
    0x1b: 'Frozen Prevent Initial',
    0x1c: 'Frozen Prevent Pause',
    0x1d: 'Frozen Prevent Running',
    0x22: 'Audible Diagnosis',
    0x23: 'Auto DT Open Pause',
    0x24: 'Confirm Start For Control',
}

const SOIL: Record<number, string> = {
    0: 'None',
    1: 'Light',
    2: 'Light-Normal',
    3: 'Normal',
    4: 'Normal-Heavy',
    5: 'Heavy',
}

const TEMP: Record<number, string> = {
    0: 'None',
    13: 'Tap Cold',
    14: 'Cold',
    15: 'Eco Warm',
    16: 'Warm',
    17: 'Warm Rinse',
    18: 'Hot',
    19: 'Extra Hot',
}

const SPIN: Record<number, string> = {
    0: 'None',
    12: 'Drain Only',
    13: 'Low',
    14: 'Medium',
    15: 'High',
    16: 'Extra High',
}

// Course code -> name. The modelJson names the courses but assigns no numeric codes, so these were read off
// the dial live against the cloud's own course field — a full sweep of every dial position (2026-09-05),
// including the long-press Spin Only. 0xFF is the downloaded-course slot.
const COURSE: Record<number, string> = {
    0x00: 'None', // idle / nothing selected — the dial hasn't been read (power-on, standby)
    0x05: 'Allergiene',
    0x0d: 'Bedding',
    0x16: 'Delicates',
    0x23: 'Heavy Duty',
    0x2e: 'Normal',
    0x30: 'Perm. Press',
    0x3c: 'Sanitary',
    0x4a: 'Speed Wash',
    0x4e: 'Spin Only',
    0x54: 'Towels',
    0x55: 'Tub Clean',
    0x5a: 'Bright Whites',
    0xff: 'Downloaded Course',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        // NO device_class: this is power on/off (state != Off), not cycle-running. device_class
                        // 'running' would relabel the ON state as "Running", which reads wrong on an idle-but-
                        // powered machine. Whether a cycle is actually running is the `status` sensor's job.
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    previous_status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-previous_status',
                        state_topic: '$this/previous_status',
                        name: 'Previous status',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    course_code: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course_code',
                        state_topic: '$this/course_code',
                        name: 'Course code',
                        icon: 'mdi:pound',
                        entity_category: 'diagnostic',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay Wash',
                        icon: 'mdi:clock-plus-outline',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay Wash time remaining',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Cycle time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    extra_rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-plus',
                        state_class: 'measurement',
                    },
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse_count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinse count (total)',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    rinse_spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_spin',
                        state_topic: '$this/rinse_spin',
                        name: 'Rinse + Spin',
                        icon: 'mdi:water-sync',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'FreshCare',
                        icon: 'mdi:tumble-dryer',
                    },
                    signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-signal',
                        state_topic: '$this/signal',
                        name: 'Signal',
                        icon: 'mdi:bell',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock',
                        // No device_class: we publish ON = locked, but HA's 'lock' class means ON = UNLOCKED, so
                        // it would invert. Plain On/Off with the lock icon reads correctly (On = locked).
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        icon: 'mdi:cellphone-wireless',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycles Since Clean',
                        icon: 'mdi:counter',
                        state_class: 'total',
                        entity_category: 'diagnostic',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Course energy',
                        icon: 'mdi:lightning-bolt',
                        state_class: 'measurement',
                        // the cloud calls this courseSpendPower and gives it no unit; published raw
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0xBD/0xCD dumps, 0x31 serial, 0x72/0xD8/0xE6/0x00 heartbeats and misc are not yet decoded.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== RECORD_MARKER) return

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE[state] ?? `Unknown (${state})`)
        this.publishProperty('previous_status', STATE[rec[PRESTATE_OFFSET]] ?? `Unknown (${rec[PRESTATE_OFFSET]})`)
        this.publishProperty('course_code', rec[COURSE_OFFSET])
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        // Zeroed while Off: the machine keeps stale settings bytes after power-off.
        const reserve = (rec[RESERVE_HI_OFFSET] << 8) | rec[RESERVE_LO_OFFSET]
        this.publishProperty('delay_wash', reserve > 0 ? 'ON' : 'OFF')
        this.publishProperty('reserve_time', reserve)
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('soil', SOIL[rec[SOIL_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        // Extra Rinse is one number, 0..3 — the count of extra rinses the user added, straight off rec[4]
        // (0x0E none .. 0x11 +3). rinse_count (rec[28]) is the TOTAL including course-built-in rinses, so it
        // can exceed the extra count (e.g. Towels = 3 total with 0 extra); kept as a diagnostic, not the headline.
        this.publishProperty('extra_rinse', Math.max(0, Math.min(3, rec[RINSE_OFFSET] - 0x0e)))
        this.publishProperty('rinse_count', rec[RINSE_COUNT_OFFSET])
        this.publishProperty('cold_wash', (rec[OPTS35_OFFSET] & OPT35_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', (rec[OPTS35_OFFSET] & OPT35_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (rec[OPTS35_OFFSET] & OPT35_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPTS36_OFFSET] & OPT36_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', (rec[OPTS36_OFFSET] & OPT36_RINSE_SPIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (rec[OPTS37_OFFSET] & OPT37_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('signal', (rec[SIGNAL_OFFSET] & SIGNAL_BIT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (rec[OPTS38_OFFSET] & OPT38_DOOR_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (rec[OPTS38_OFFSET] & OPT38_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (rec[OPTS38_OFFSET] & OPT38_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        // No door sensor: rec[38] 0x40 is remote-start (above), not the door; nothing else in the frame tracks it.
        this.publishProperty('spin', SPIN[rec[SPIN_OFFSET]] ?? 'unknown')
        this.publishProperty('cycles', rec[CYCLES_OFFSET])
        this.publishProperty('energy', rec[ENERGY_OFFSET])
    }

    // ---- write path (control) ----
    // Command opcode for this model is F0 E5 (the sibling's F0 24/2A does NOT apply here). Each command below
    // is the EXACT inner captured from the real LG cloud driving this machine through rethink's bridge, verified
    // by re-deriving the on-wire checksum via AABBDevice.send(). Remote control requires "Remote Start" armed on
    // the appliance (it pre-locks the door).
    start() {
        // connection init — makes the appliance begin streaming status frames (captured toDevice handshake)
        this.send(Buffer.from('f0ed1121010000001800', 'hex'))
    }

    setProperty(prop: string, value: string) {
        // All commands below are EXACT cloud->device packets captured via bridge mode while driving the LG app,
        // each checksum-verified against AABBDevice.send(). Remote control needs "Remote Start" armed on the unit.
        if (prop === 'start')
            this.send(Buffer.from('f0e5000201ff010301', 'hex')) // begin the selected cycle
        else if (prop === 'pause') this.send(Buffer.from('f0e5000201ff010302', 'hex'))
        else if (prop === 'resume')
            this.send(Buffer.from('f0e5000201ff0244000303', 'hex')) // resume-from-pause: a DISTINCT, longer packet than start
        else if (prop === 'power' && value === 'OFF') {
            // WMOff. WARNING: remote power-off drops the appliance's Wi-Fi module and there is NO reliable
            // remote wake afterward — you strand the connection and must walk to the machine. The LG app warns
            // about this too. Exposed for completeness; do not automate.
            this.send(Buffer.from('f0e5000201ff010200', 'hex'))
        }
        // Not captured/implemented: power ON (WMWakeup — moot after a remote off), and WMDownload (select a full
        // cycle remotely) which packs course/soil/spin/temp/reserve/freshCare into one blob at start.
    }
}
