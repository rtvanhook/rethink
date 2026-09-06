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
// Field offsets are relative to the record's 0x2B marker (rec[0]). Values were verified against the LG cloud's
// own decoded washerDryer state (bridge mode) and the LG ThinQ integration in Home Assistant, and by driving the
// panel and watching the byte move. Enum indices are the modelJson's MonitoringValue indices verbatim.
//
//   rec[2]   soil            enum (SOIL)
//   rec[3]   temp            enum (TEMP)
//   rec[4]   rinse level     0x0E none .. 0x11 +3 extra — published as extra_rinse (flag) + extra_rinse_count (0..3)
//   rec[5]   spin            enum (SPIN)
//   rec[6]   course          dial position; COURSE maps the codes to names (read off the dial — the modelJson
//                            names the courses but assigns them no numeric ids)
//   rec[12:14] reserve       delay-wash minutes, 16-bit big-endian; 0 unless a delay is armed
//   rec[14:16] remainTime    hour, minute — remaining time
//   rec[16:18] initialTime   hour, minute — total cycle time
//   rec[19]  courseSpendPower LG's field name; tracks a cloud value but its unit/meaning is undocumented — published raw
//   rec[22]  state           enum (STATE); rec[23] holds the previous state
//   rec[28]  rinse count     TOTAL rinses incl. a course's built-ins; NOT published (extra_rinse_count is the added count)
//   rec[29]  cycles          count since the last Tub Clean
//   rec[30]  bit 0x04        Signal (end-of-cycle chime / button beeps)
//   rec[35]  bit 0x04 cold wash, 0x20 turbo wash (course-locked on some courses), 0x40 pre-wash
//   rec[36]  bit 0x10 steam, 0x20 Rinse+Spin subcycle (temp & soil report null while it is active)
//   rec[37]  bit 0x40 FreshCare
//   rec[38]  bit 0x10 door lock, 0x20 child lock, 0x40 a door-latch state bit (see the door note in processStatus)
//
// Examined and left unmapped (not user-facing features): rec[21] single-frame transient; rec[25] phase-progress
// sub-byte, redundant with state; rec[41] powered-on/settings-active flag. This frame carries no door-POSITION
// sensor and no remote-start bit (see the door note in processStatus). Error codes not yet observed.

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
// rec[38] bit 0x10 = DOOR LOCK — set whenever the door is locked: a running cycle, an armed delay, or an armed
// remote start (which pre-locks the door so it can start unattended). This frame carries no remote-start-specific
// bit; "remote start armed" is indistinguishable from any other locked state, so we publish only the lock.
const OPTS36_OFFSET = 36
const OPT36_STEAM = 0x10
const OPT36_RINSE_SPIN = 0x20 // pinned live: rec[36] bit 0x20 = Rinse+Spin subcycle active (a modifier on the
// selected course, not a course itself); while set, temp & soil report null (0x00) since it does not wash
const OPTS37_OFFSET = 37
const OPT37_FRESH_CARE = 0x40 // pinned live: rec[37] 0x00->0x40 with cloud freshCare ON
const OPTS38_OFFSET = 38
const OPT38_DOOR_LOCK = 0x10
const OPT38_CHILD_LOCK = 0x20 // child lock; confirmed against the cloud's childLock (this model exposes it in-frame, unlike the sibling)
// rec[38] bit 0x40 is a door-latch STATE bit (set when the door is closed-but-unlocked, cleared when locked or
// open), NOT a reliable door-position sensor — see the door note in processStatus. Not published.

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
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-plus',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse_count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-plus',
                        state_class: 'measurement',
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
        this.publishProperty('course_code', '0x' + rec[COURSE_OFFSET].toString(16).padStart(2, '0'))
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        // Zeroed while Off: the machine keeps stale settings bytes after power-off.
        const reserve = (rec[RESERVE_HI_OFFSET] << 8) | rec[RESERVE_LO_OFFSET]
        this.publishProperty('delay_wash', reserve > 0 ? 'ON' : 'OFF')
        this.publishProperty('reserve_time', reserve)
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('soil', SOIL[rec[SOIL_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        // Extra rinses the user added, off rec[4] (0x0E none .. 0x11 +3), split into a flag + a 0..3 count to
        // match the sibling's shape. (rec[28] holds the TOTAL rinse count including a course's built-in rinses;
        // not published — the added count is what the panel's Extra Rinse button controls.)
        const extraRinses = Math.max(0, Math.min(3, rec[RINSE_OFFSET] - 0x0e))
        this.publishProperty('extra_rinse', extraRinses > 0 ? 'ON' : 'OFF')
        this.publishProperty('extra_rinse_count', extraRinses)
        this.publishProperty('cold_wash', (rec[OPTS35_OFFSET] & OPT35_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', (rec[OPTS35_OFFSET] & OPT35_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (rec[OPTS35_OFFSET] & OPT35_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPTS36_OFFSET] & OPT36_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', (rec[OPTS36_OFFSET] & OPT36_RINSE_SPIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (rec[OPTS37_OFFSET] & OPT37_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('signal', (rec[SIGNAL_OFFSET] & SIGNAL_BIT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (rec[OPTS38_OFFSET] & OPT38_DOOR_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (rec[OPTS38_OFFSET] & OPT38_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        // No door-position entity by design. The machine emits a frame only on a STATE change, never on the door
        // itself opening or closing, so any door sensor would sit stale and read wrong — and an unreliable door
        // state is a tempting thing to automate on, which makes it a trap. Only the door LOCK (above) is
        // frame-backed and reliable. (LG's own app shows no door tile for this model either.)
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
