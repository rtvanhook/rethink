import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13D4ASJW_D_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13D4ASJW_D_US'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.10.121' }

// All fixtures are REAL frames captured live from the appliance (LG DLEX4000W, 2026-09-19) via
// rethink-capture --cloud, each cross-checked against the LG cloud's own decoded washerDryer state in the
// same second — not guessed from static analysis. The comments name the cloud field that confirmed each.
// Single-record 0xEB frame right after power-on, nothing selected yet: cloud state:"INITIAL", preState:"POWEROFF", courseDryer27inchBase:"NOT_SELECTED", remainTimeMinute:1.
const EB_INITIAL_POWER_ON = buf('aa2330eb001b010001000100000000000400000040a8000000000000006400000003bb')
// Remote Start pressed on the panel: rec[16] bit 0x01, cloud remoteStart:"REMOTE_START_ON".
const REMOTE_START_ON = buf(
    'aa4030ec001b010001000100000000000400000040a80000000000000064000000001b010001000100000000000400000040a90000000000000064000000b6bb',
)
// Dial to Heavy Duty: course 0x01, dryLevel:"DRYLEVEL_NORMAL", temp:"TEMP_HIGH", 54 min.
const HEAVY_DUTY = buf(
    'aa4030ec001b010001000100000000000400000040a80000000000000064000000001b010036003601000305000400000040a8000000000000006400000000bb',
)
// Antibacterial: cloud remainTimeHour:1 + remainTimeMinute:10 -> a single 70-minute value; dryLevel:"DRYLEVEL_VERYDRY".
const ANTIBACTERIAL = buf(
    'aa4030ec001b010037003707000303000400000040a80000000000000064000000001b01010a010a08000505000400000040a80000000000000064000000d4bb',
)
// Steam Fresh: no dry level (0), temp "TEMP_MEDIUMHIGH", and a load-item count of 2 in rec[23] (cloud loadItem:"LOADITEM_2").
const STEAM_FRESH_LOAD_ITEM = buf(
    'aa4030ec001b01010a010a08000505000400000040a80000000000000064000000001b01000a000a15000004000400000040a8000000000000026400000060bb',
)
// Normal at the Normal dry level switches Energy Saver on by itself: rec[16] bit 0x02, cloud energySaver:"ENERGYSAVER_ON".
const NORMAL_ENERGY_SAVER = buf(
    'aa4030ec001b010036003601000305000400000040a80000000000000064000000001b010039003903000304000400000040aa000000000000006400000084bb',
)
// Air Dry: no heating element, temp 0 (cloud temp:"NO_TEMP"), 30 min.
const AIR_DRY = buf(
    'aa4030ec001b010019001910000005000400000040a80000000000000064000000001b01001e001e11000000000400000040a8000000000000006400000027bb',
)
// The Downloaded dial position reports the loaded smart course: rec[6]=0x1a, cloud courseDryer27inchBase and smartCourseDryer27inchBase both "SUPERDRY".
const DOWNLOADED_SUPER_DRY = buf(
    'aa4030ec001b01001e001e11000000000400000040a80000000000000064000000001b01003b003b1a000505000400000040a800000000640000640000007cbb',
)
// Reduce Static on: rec[15] bit 0x02, cloud reduceStatic:"REDUCESTATIC_ON"; the load-item count went to 5 and the estimate up 2 min in the same frame.
const REDUCE_STATIC_ON = buf(
    'aa4030ec001b010039003903000304000400000000aa0000000000000064000000001b010037003703000304000400000002aa000000000000056400000008bb',
)
// Child Lock on: rec[15] bit 0x01, cloud childLock:"CHILDLOCK_ON".
const CHILD_LOCK_ON = buf(
    'aa4030ec001b010039003903000304000400000000aa0000000000000264000000001b010039003903000304000400000001aa00000000000002640000000abb',
)
// Dry level stepped to Damp (rec[8]=1), cloud dryLevel:"DRYLEVEL_DAMPDRY".
const DRY_LEVEL_DAMP = buf(
    'aa4030ec001b01003b003b03000504000400000000a80000000000000064000000001b01001e001e03000104000400000000a8000000000000006400000071bb',
)
// Dry level stepped to Very (rec[8]=5), cloud dryLevel:"DRYLEVEL_VERYDRY".
const DRY_LEVEL_VERY = buf(
    'aa4030ec001b010032003203000404000400000000a80000000000000064000000001b01003b003b03000504000400000000a800000000000000640000001abb',
)
// Damp Dry Signal on: rec[15] bit 0x08, cloud dampDrySignal:"DAMPDRYSIGNAL_ON".
const DAMP_DRY_SIGNAL_ON = buf(
    'aa4030ec001b010036003601000305000400000000a80000000000000064000000001b010036003601000305000400000008a8000000000000006400000005bb',
)
// Wrinkle Care on: rec[15] bit 0x10 (the RV13B6ES offset, NOT RV13B6BSD's rec[16]), cloud wrinkleCare:"WRINKLECARE_ON".
const WRINKLE_CARE_ON = buf(
    'aa4030ec001b010036003601000305000400000000a80000000000000064000000001b010036003601000305000400000010a800000000000000640000000dbb',
)
// Wrinkle Care off again, cloud wrinkleCare:"WRINKLECARE_OFF".
const WRINKLE_CARE_OFF = buf(
    'aa4030ec001b010036003601000305000400000010a80000000000000064000000001b010036003601000305000400000000a800000000000000640000000dbb',
)
// Signal (beeper) pressed: rec[11] 0x04 -> 0x00, the panel's single On/Off Signal lamp going out. NOT cloud-confirmed — the cloud sends no signal field for this family.
const SIGNAL_OFF = buf(
    'aa4030ec001b010036003601000305000400000000a80000000000000064000000001b010036003601000305000000000000a8000000000000006400000011bb',
)
// Turbo Steam on: rec[16] bit 0x04, cloud turboSteam:"TURBOSTEAM_ON".
const TURBO_STEAM_ON = buf(
    'aa4030ec001b010036003601000305000400000000a80000000000000064000000001b010036003601000305000400000000ac000000000000006400000019bb',
)
// Time Dry (course 0x12) with More/Less Time pressed three times: rec[12]=0x0f (+15), cloud moreLessTime:15, 55 min.
const TIME_DRY_PLUS_15 = buf(
    'aa4030ec001b01003200321200000503040a000040a80000000000000064000000001b01003700371200000503040f000040a80000000000000064000000a8bb',
)
// Temp stepped to Ultra Low on Time Dry (rec[9]=1), cloud temp:"TEMP_ULTRALOW".
const TEMP_ULTRA_LOW = buf(
    'aa4030ec001b01003700371200000503040f000040a80000000000000064000000001b01003700371200000103040f000040a800000000000000640000005dbb',
)

// Time Dry button stepped to 50: rec[10]=4, cloud timeDry:"TIMEDRY_50", 50 min.
const TIME_DRY_50 = buf(
    'aa4030ec001b010028002812000005030400000040280000000000000064000000001b01003200321200000504040000004028000000000000006400000092bb',
)
// Time Dry stepped to 60: rec[10]=5, 1h00 as [hour][minute] = 01 00.
const TIME_DRY_60 = buf(
    'aa4030ec001b010032003212000005040400000040280000000000000064000000001b0101000100120000050504000000402800000000000000640000002ebb',
)
// Time Dry stepped to 20: rec[10]=1, cloud timeDry:"TIMEDRY_20".
const TIME_DRY_20 = buf(
    'aa4030ec001b010100010012000005050400000040280000000000000064000000001b01001400141200000501040000004028000000000000006400000069bb',
)
// Normal at the Normal dry level with Energy Saver switched OFF by hand: rec[16] lost both 0x02 and the 0x80 automatic bit, and rec[17] gained 0x04 — the panel's AI lamp lit. Cloud energySaver:"ENERGYSAVER_OFF".
const NORMAL_ENERGY_SAVER_OFF_AI = buf(
    'aa4030ec001b010039003903000304000400000040aa0000000000000064000000001b01002900290300030400040000004028040000000000006400000069bb',
)
// Remote Start armed on that same Normal setup: rec[16] bit 0x01, cloud remoteStart:"REMOTE_START_ON". This is the record the app's Start was issued against.
const ARMED_NORMAL = buf(
    'aa4030ec001b010029002903000304000400000040280400000000000064000000001b010029002903000304000400000040290400000000000064000000cabb',
)
// App Start: phase 0x32, cloud state:"DRYING"; rec[20] keeps the previous phase 0x01.
const DRYING = buf(
    'aa4030ec001b010029002903000304000400000040290400000000000064000000001b3200290029030003040004000000002900001c0100000064000000ffbb',
)
// App Pause: phase 0x03, cloud state:"PAUSE"; rec[20] = 0x32.
const PAUSED = buf(
    'aa4030ec001b3200290029030003040004000000002900001c0100000064000000001b03002900290300030400040000004029000039320000006400000046bb',
)
// App Resume: back to 0x32, rec[20] = 0x03.
const RESUMED = buf(
    'aa4030ec001b030029002903000304000400000040290000393200000064000000001b3200290029030003040004000000002900004103000000640000006fbb',
)
// App Power Off mid-cycle: phase 0x00, cloud state:"POWEROFF", course/dry level/temp reset to 0; rec[20] = 0x32.
const POWERED_OFF = buf(
    'aa4030ec001b320028002903000304000400000000290000550300000064000000001b00002800280000000000040000004028000068320000006400000039bb',
)

// Right after the app downloaded Denim: the record selected its base course Khaki/Jean (0x0a) and the Downloaded
// slot reads 0x65 at rec[24] (and rec[21]); cloud courseDryer27inchBase:"KHAKIJEAN", downloadedCourseDryer27inchBase:"DENIM".
const DENIM_DOWNLOADED = buf(
    'aa4030ec001b01001e001e12000005020400000000290000000000000064000000001b01002300230a00030300040000000029000000006500006500000024bb',
)

// The app's start of the downloaded Denim smart course, 2026-09-19: base course 0x0a with 0x65 at offset 11.
const DENIM_START_HEX = 'aa1bf0260a0000030000000041000a650000000300dd0000002dbb'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}
function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('RV13D4ASJW_D_US', () => {
    test('0xEB single-record frame after power-on decodes with the 0xEC offsets', () => {
        const p = feed([EB_INITIAL_POWER_ON])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.course, 'None')
        assert.equal(p.remaining_time, 1)
    })
    test('remote start is rec[16] bit 0x01', () => {
        assert.equal(feed([REMOTE_START_ON]).remote_start, 'ON')
        assert.equal(feed([HEAVY_DUTY]).remote_start, 'OFF')
    })
    test('dial courses decode by rec[6] with the cloud-confirmed defaults', () => {
        const hd = feed([HEAVY_DUTY])
        assert.equal(hd.course, 'Heavy Duty')
        assert.equal(hd.dry_level, 'Normal')
        assert.equal(hd.temp, 'High')
        assert.equal(hd.remaining_time, 54)
        assert.equal(hd.initial_time, 54)
        assert.equal(feed([AIR_DRY]).course, 'Air Dry')
        assert.equal(feed([AIR_DRY]).temp, 'None') // 0 = NO_TEMP
        assert.equal(feed([AIR_DRY]).remaining_time, 30)
    })
    test('hour + minute fields combine into one duration', () => {
        const p = feed([ANTIBACTERIAL])
        assert.equal(p.course, 'Antibacterial')
        assert.equal(p.remaining_time, 70)
        assert.equal(p.initial_time, 70)
        assert.equal(p.dry_level, 'Very')
    })
    test('the Downloaded position reports the loaded smart course', () => {
        assert.equal(feed([DOWNLOADED_SUPER_DRY]).course, 'Super Dry')
    })
    test('load item count lives in rec[23]', () => {
        assert.equal(feed([STEAM_FRESH_LOAD_ITEM]).load_item, 2)
        assert.equal(feed([REDUCE_STATIC_ON]).load_item, 5)
        assert.equal(feed([HEAVY_DUTY]).load_item, 0)
    })
    test('rec[15] option bits', () => {
        assert.equal(feed([CHILD_LOCK_ON]).child_lock, 'ON')
        assert.equal(feed([REDUCE_STATIC_ON]).reduce_static, 'ON')
        assert.equal(feed([DAMP_DRY_SIGNAL_ON]).damp_dry_signal, 'ON')
        assert.equal(feed([WRINKLE_CARE_ON]).wrinkle_care, 'ON')
        assert.equal(feed([WRINKLE_CARE_OFF]).wrinkle_care, 'OFF')
        const hd = feed([HEAVY_DUTY])
        assert.equal(hd.child_lock, 'OFF')
        assert.equal(hd.reduce_static, 'OFF')
        assert.equal(hd.damp_dry_signal, 'OFF')
        assert.equal(hd.wrinkle_care, 'OFF')
    })
    test('rec[16] option bits', () => {
        assert.equal(feed([NORMAL_ENERGY_SAVER]).energy_saver, 'ON')
        assert.equal(feed([HEAVY_DUTY]).energy_saver, 'OFF')
        assert.equal(feed([TURBO_STEAM_ON]).turbo_steam, 'ON')
        assert.equal(feed([HEAVY_DUTY]).turbo_steam, 'OFF')
    })
    test('dry level and temperature steps', () => {
        assert.equal(feed([DRY_LEVEL_DAMP]).dry_level, 'Damp')
        assert.equal(feed([DRY_LEVEL_VERY]).dry_level, 'Very')
        assert.equal(feed([TEMP_ULTRA_LOW]).temp, 'Ultra Low')
        assert.equal(feed([STEAM_FRESH_LOAD_ITEM]).temp, 'Mid High')
    })
    test('More/Less Time is a signed minute offset in rec[12]', () => {
        const p = feed([TIME_DRY_PLUS_15])
        assert.equal(p.course, 'Time Dry')
        assert.equal(p.more_less_time, 15)
        assert.equal(p.remaining_time, 55)
        assert.equal(feed([HEAVY_DUTY]).more_less_time, 0)
    })
    test('signal (beeper) byte, panel-confirmed only', () => {
        assert.equal(feed([SIGNAL_OFF]).signal, 'Off')
        assert.equal(feed([HEAVY_DUTY]).signal, 'On')
    })
    test('Time Dry duration selector, rec[10]', () => {
        assert.equal(feed([TIME_DRY_20]).time_dry, '20 min')
        assert.equal(feed([TIME_DRY_50]).time_dry, '50 min')
        const p = feed([TIME_DRY_60])
        assert.equal(p.time_dry, '60 min')
        assert.equal(p.remaining_time, 60)
        assert.equal(feed([HEAVY_DUTY]).time_dry, 'None')
    })
    test('AI lamp (rec[17] 0x04) and Energy Saver automatic (rec[16] 0x80)', () => {
        const auto = feed([NORMAL_ENERGY_SAVER])
        assert.equal(auto.energy_saver, 'ON')
        assert.equal(auto.energy_saver_auto, 'ON')
        assert.equal(auto.ai, 'OFF')
        const manual = feed([NORMAL_ENERGY_SAVER_OFF_AI])
        assert.equal(manual.energy_saver, 'OFF')
        assert.equal(manual.energy_saver_auto, 'OFF')
        assert.equal(manual.ai, 'ON')
    })
    test('phases through an app-driven start, pause, resume and power off', () => {
        const d = feed([DRYING])
        assert.equal(d.status, 'Drying')
        assert.equal(d.previous_status, 'Initial')
        const p = feed([PAUSED])
        assert.equal(p.status, 'Pause')
        assert.equal(p.previous_status, 'Drying')
        assert.equal(feed([RESUMED]).previous_status, 'Pause')
        const off = feed([POWERED_OFF])
        assert.equal(off.power, 'OFF')
        assert.equal(off.status, 'Off')
        assert.equal(off.course, 'None')
        assert.equal(off.remaining_time, 0)
    })
    test('start reproduces the app command byte for byte from the last record', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_NORMAL)
        dev.setProperty('start', '')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0260300000400000000410003000000000300000000007cbb'],
        )
    })
    test('start from a pause is the same packet without the new-cycle bit (the captured resume)', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', PAUSED)
        dev.setProperty('start', '')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf026030000040000000001000300000000030000000000bcbb'],
        )
    })
    test('pause and power off are the captured 0xF024 frames; power off needs the two-step select value', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', DRYING)
        dev.setProperty('pause', '')
        dev.setProperty('power_off', 'unknown')
        dev.setProperty('power_off', 'Power Off')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa09f02404010099bb', 'aa09f0240101009cbb'],
        )
    })
    test('downloaded course reads back from rec[24]', () => {
        assert.equal(feed([DOWNLOADED_SUPER_DRY]).downloaded_course, 'Super Dry')
        const p = feed([DENIM_DOWNLOADED])
        assert.equal(p.downloaded_course, 'Denim')
        assert.equal(p.course, 'Khaki/Jean')
        assert.equal(p.temp, 'Medium')
        assert.equal(p.dry_level, 'Normal')
    })
    test('specialty download sends the captured WMDownload frame and re-arms the select', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_NORMAL)
        dev.setProperty('specialty', 'Denim')
        dev.setProperty('specialty', 'Socks') // Time Dry 30 + More Time 5 ride in the body
        dev.setProperty('specialty', 'Overnight Dry') // Wrinkle Care in the flags byte
        dev.setProperty('specialty', 'Static Reduce') // Reduce Static flag + load item 5 at body[16]
        dev.setProperty('specialty', 'Rack Dry') // base course 0x13, no heat, no sensing
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            [
                'aa1df02503150a0000030000000001000a6500000003000000000021bb',
                'aa1df0250315120000050000020001001271000000000005000000c3bb',
                'aa1df02503150d0000020000001001000d72000000030000000000c3bb',
                'aa1df02503150300000300000002010003cc00000003050000000081bb',
                'aa1df02503151300000000000000010013d0000000000000000000bebb',
            ],
        )
        assert.equal(ha.devices[DEVICE_ID].properties.specialty, 'unknown')
    })
    test('start_json rebuilds the three app-committed starts byte for byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_NORMAL)
        dev.setProperty('start_json', JSON.stringify({ course: 'Normal' }))
        dev.setProperty('start_json', JSON.stringify({ course: 'Normal', wrinkle_care: true }))
        dev.setProperty('start_json', JSON.stringify({ course: 'Time Dry', temp: 'Medium', minutes: 38 }))
        dev.setProperty('start_course', 'Normal')
        dev.setProperty('start_json', JSON.stringify({ course: 'Bogus' })) // refused, nothing sent
        dev.setProperty('start_json', JSON.stringify({ course: 'Heavy Duty', minutes: 30 })) // minutes only on Time Dry
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            [
                'aa1bf0260300000400000000430003000000000300000000007ebb',
                'aa1bf0260300000400000010430003000000000300000000006ebb',
                'aa1bf0261200000300000300410012000000000000fe00000011bb',
                'aa1bf0260300000400000000430003000000000300000000007ebb',
            ],
        )
    })
    test('a smart course starts as its base course with the code at offset 11 (the captured Denim start)', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_NORMAL)
        dev.setProperty('start_json', JSON.stringify({ course: 'Denim', more_less_time: -35 }))
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            [DENIM_START_HEX],
        )
    })
})
