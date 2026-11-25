import { StreamPref } from "@/enums/pref-keys";
import { GyroAxes, GyroBehavior, GyroMode, GyroSource, GyroStick } from "@/enums/pref-values";
import { BxEventBus } from "@/utils/bx-event-bus";
import { BxLogger } from "@/utils/bx-logger";
import { generateVirtualControllerMapping, isGyroCapableGamepad, isMotionSensorSubGamepad } from "@/utils/gamepad";
import { AppInterface, STATES } from "@/utils/global";
import { getStreamPref, setStreamPref } from "@/utils/pref-utils";
import { Toast } from "@/utils/toast";
import { t } from "@/utils/translation";
import { UserAgent } from "@/utils/user-agent";

export type ExternalGyroSample = {
    // Angular velocity in deg/s (controller/screen frame: +wx pitch up, -wy yaw right, -wz roll right)
    wx?: number;
    wy?: number;
    wz?: number;
    // Gravity / accelerometer vector in g (+gx right, +gy up, +gz toward user)
    gx?: number;
    gy?: number;
    gz?: number;
    source?: 'device' | 'controller';
};

export type GyroSensorStatus = {
    deviceApiSupported: boolean;
    deviceReceiving: boolean;
    controllerGamepadDetected: boolean;
    controllerGyroActive: boolean;
    controllerMethod: 'webhid' | 'gamepad' | 'bridge' | null;
    controllerName: string | null;
    webHidSupported: boolean;
};

type SampleState = {
    // Screen/controller-aligned angular rates (deg/s):
    // aimRightRate > 0 means turning/aiming right; aimUpRate > 0 means pitching/aiming up; rollRightRate > 0 means rolling clockwise
    aimRightRate: number;
    aimUpRate: number;
    rollRightRate: number;

    // Gravity vector normalized (~1g) in screen/controller frame (+X right, +Y up, +Z toward user)
    gx: number;
    gy: number;
    gz: number;
    hasGravity: boolean;

    // Fallback orientation angles (deg)
    fallbackRollDeg: number;
    fallbackPitchDeg: number;
    hasFallbackAngles: boolean;

    // Stationary bias estimation (deg/s)
    biasRight: number;
    biasUp: number;
    biasRoll: number;
    stillFrames: number;

    lastTimestamp: number;
};

const HID_FILTERS = [
    // Sony DualSense / DualSense Edge / DualShock 4
    { vendorId: 0x054c, productId: 0x0ce6 },
    { vendorId: 0x054c, productId: 0x0df2 },
    { vendorId: 0x054c, productId: 0x05c4 },
    { vendorId: 0x054c, productId: 0x09cc },
    { vendorId: 0x054c, productId: 0x0ba0 },
    // Nintendo Switch Pro Controller / Joy-Con
    { vendorId: 0x057e, productId: 0x2009 },
    { vendorId: 0x057e, productId: 0x2006 },
    { vendorId: 0x057e, productId: 0x2007 },
    { vendorId: 0x057e, productId: 0x200e },
];

// xCloud's GamepadInputPhysicality bits. Every gamepad report tells the server which inputs are driven
// by a physical controller and which by the on-screen (virtual) one. Stick movement with no matching
// bit is treated as a real controller, which makes the server hide the touch controls.
const PHYSICALITY_LEFT_STICK = 262144 | 524288;
const PHYSICALITY_RIGHT_STICK = 1048576 | 2097152;

function createEmptySampleState(): SampleState {
    return {
        aimRightRate: 0,
        aimUpRate: 0,
        rollRightRate: 0,
        gx: 0,
        gy: 1,
        gz: 0,
        hasGravity: false,
        fallbackRollDeg: 0,
        fallbackPitchDeg: 0,
        hasFallbackAngles: false,
        biasRight: 0,
        biasUp: 0,
        biasRoll: 0,
        stillFrames: 0,
        lastTimestamp: 0,
    };
}

function clamp(val: number, min: number, max: number): number {
    return val < min ? min : (val > max ? max : val);
}

function unwrapAngleDelta(curr: number, prev: number): number {
    let delta = curr - prev;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
}

export class GyroManager {
    private static instance: GyroManager;
    public static getInstance = () => GyroManager.instance ?? (GyroManager.instance = new GyroManager());

    private readonly LOG_TAG = 'GyroManager';

    private deviceState: SampleState = createEmptySampleState();
    private controllerState: SampleState = createEmptySampleState();

    // Neutral center angles (in degrees) for Tilt / Steering mode
    private neutralRollDeg = 0;
    private neutralPitchDeg = 0;
    private needsRecenter = true;

    // Fallback orientation derivative state for devices without rotationRate
    private prevOrientAlpha: number | null = null;
    private prevOrientBeta: number | null = null;
    private prevOrientGamma: number | null = null;
    private prevOrientTime = 0;
    private hasNativeRotationRate = false;

    private deviceListening = false;
    private devicePermissionGranted = false;
    private isDialogOpen = false;
    private rafId: number | null = null;

    // Smoothed output values
    private smoothX = 0;
    private smoothY = 0;
    private lastSentGx = 0;
    private lastSentGy = 0;
    private wasApplyingGyro = false;
    // Whether the last computed output came from a controller's sensor (physical) or the device's own (virtual)
    private outputFromController = false;

    // Base gamepad state captured from xCloud input pipeline
    private lastBaseGamepad: XcloudGamepad = generateVirtualControllerMapping(0);
    private hasSeenGamepadPacket = false;
    private virtualConnectedOnce = false;
    private lastExternalPacketTime = 0;

    // WebHID controller devices
    private openedHidDevices: Set<any> = new Set();
    private switchPacketNumber = 0;
    // Diagnostics, shown in the settings dialog
    private hidReportCount = 0;
    private hidLastReportId = -1;
    private hidZeroImuStreak = 0;
    private hidImuEnableAt = 0;
    private hidImuEnableCount = 0;
    private injectedPacketCount = 0;
    private pauseReason = '';
    private activeControllerMethod: 'webhid' | 'gamepad' | 'bridge' | null = null;
    private activeControllerName: string | null = null;

    // Cached current preferences for fast frame loop
    private mode: GyroMode = GyroMode.OFF;
    private lastActiveNonOffMode: GyroMode = GyroMode.ON;
    private source: GyroSource = GyroSource.AUTO;
    private stick: GyroStick = GyroStick.RS;
    private behavior: GyroBehavior = GyroBehavior.AUTO;
    private axes: GyroAxes = GyroAxes.AUTO;
    private sensitivityX = 100;
    private sensitivityY = 100;
    private deadzone = 2;
    private invertX = false;
    private invertY = false;

    private constructor() {
        BxLogger.info(this.LOG_TAG, 'constructor()');
        this.probeDeviceSensorOnce();
        this.refreshSettings();
        this.setupEvents();
        this.initWebHidAutoConnect();
    }

    private probeDeviceSensorOnce() {
        if (!this.hasDeviceSensorSupport()) {
            return;
        }

        const cleanup = () => {
            window.removeEventListener('devicemotion', onMotionProbe);
            window.removeEventListener('deviceorientation', onOrientProbe);
        };

        const onMotionProbe = (e: DeviceMotionEvent) => {
            const rot = e.rotationRate;
            const acc = e.accelerationIncludingGravity;
            if ((rot && (rot.alpha !== null || rot.beta !== null || rot.gamma !== null)) ||
                (acc && (acc.x !== null || acc.y !== null || acc.z !== null))) {
                this.deviceState.lastTimestamp = performance.now();
                cleanup();
                BxEventBus.Stream.emit('gyro.sensor.status', {});
            }
        };

        const onOrientProbe = (e: DeviceOrientationEvent) => {
            if (e.alpha !== null || e.beta !== null || e.gamma !== null) {
                this.deviceState.lastTimestamp = performance.now();
                cleanup();
                BxEventBus.Stream.emit('gyro.sensor.status', {});
            }
        };

        window.addEventListener('devicemotion', onMotionProbe, { passive: true });
        window.addEventListener('deviceorientation', onOrientProbe, { passive: true });
        window.setTimeout(cleanup, 3000);
    }

    static isMotionSensorSubGamepad(gamepad: Gamepad | null | undefined): boolean {
        return isMotionSensorSubGamepad(gamepad);
    }

    static isGyroCapableGamepad(gamepad: Gamepad | null | undefined): boolean {
        return isGyroCapableGamepad(gamepad);
    }

    private getNavHid(): any {
        const key = 'h' + 'id';
        return typeof window.navigator !== 'undefined' ? (window.navigator as any)[key] : undefined;
    }

    hasWebHidSupport(): boolean {
        return !!this.getNavHid();
    }

    hasDeviceSensorSupport(): boolean {
        return ('DeviceMotionEvent' in window) || ('DeviceOrientationEvent' in window);
    }

    getSensorStatus(): GyroSensorStatus {
        let controllerGamepadDetected = false;
        let detectedGamepadName: string | null = null;
        let motionSubGamepadFound = false;

        const gamepads = window.navigator.getGamepads ? window.navigator.getGamepads() : [];
        for (const gp of gamepads) {
            if (!gp || !gp.connected) {
                continue;
            }
            if (GyroManager.isMotionSensorSubGamepad(gp)) {
                motionSubGamepadFound = true;
                controllerGamepadDetected = true;
                detectedGamepadName = detectedGamepadName || gp.id;
            } else if (GyroManager.isGyroCapableGamepad(gp)) {
                controllerGamepadDetected = true;
                detectedGamepadName = gp.id;
            }
        }

        const now = performance.now();
        const controllerRecent = this.controllerState.lastTimestamp > 0 && (now - this.controllerState.lastTimestamp < 3000);
        const deviceReceiving = this.deviceState.lastTimestamp > 0;

        let method = this.activeControllerMethod;
        if (this.openedHidDevices.size > 0) {
            method = 'webhid';
        } else if (motionSubGamepadFound) {
            method = 'gamepad';
        } else if (!controllerRecent && method !== 'bridge') {
            method = null;
        }

        return {
            deviceApiSupported: this.hasDeviceSensorSupport(),
            deviceReceiving,
            controllerGamepadDetected: controllerGamepadDetected || this.openedHidDevices.size > 0,
            controllerGyroActive: this.openedHidDevices.size > 0 || motionSubGamepadFound || controllerRecent,
            controllerMethod: method,
            controllerName: this.activeControllerName || detectedGamepadName,
            webHidSupported: this.hasWebHidSupport(),
        };
    }

    /** One line with the live state of the controller gyro pipeline, for troubleshooting */
    getDebugLine(): string {
        const c = this.controllerState;
        const channel = window.BX_EXPOSED?.inputChannel as any;
        const age = c.lastTimestamp > 0 ? Math.round(performance.now() - c.lastTimestamp) + 'ms' : 'never';
        return [
            'hid ' + this.openedHidDevices.size + ' dev, ' + this.hidReportCount + ' reports, id 0x' + (this.hidLastReportId < 0 ? '--' : this.hidLastReportId.toString(16)),
            'imu ' + (this.hidZeroImuStreak > 30 ? 'OFF' : 'ok') + ' (re-enabled ' + this.hidImuEnableCount + 'x), sample ' + age,
            'rate ' + c.aimRightRate.toFixed(0) + '/' + c.aimUpRate.toFixed(0) + ' dps',
            'mode ' + this.mode + ', source ' + this.source + ', hook ' + (channel ? (channel._bxGyroHooked ? 'yes' : 'no') : 'no channel'),
            'sent ' + this.injectedPacketCount + ', stick ' + this.lastSentGx.toFixed(2) + '/' + this.lastSentGy.toFixed(2) + (this.pauseReason ? ', paused: ' + this.pauseReason : ''),
        ].join(' | ');
    }

    isEnabled(): boolean {
        return this.mode !== GyroMode.OFF;
    }

    isActivelyPolling(): boolean {
        return STATES.isPlaying && this.mode !== GyroMode.OFF;
    }

    refreshSettings = () => {
        this.mode = getStreamPref(StreamPref.GYRO_MODE);
        if (this.mode !== GyroMode.OFF) {
            this.lastActiveNonOffMode = this.mode;
        }

        this.source = getStreamPref(StreamPref.GYRO_SOURCE);
        this.stick = getStreamPref(StreamPref.GYRO_STICK);
        this.behavior = getStreamPref(StreamPref.GYRO_BEHAVIOR);
        this.axes = getStreamPref(StreamPref.GYRO_AXES);
        this.sensitivityX = getStreamPref(StreamPref.GYRO_SENSITIVITY_X);
        this.sensitivityY = getStreamPref(StreamPref.GYRO_SENSITIVITY_Y);
        this.deadzone = getStreamPref(StreamPref.GYRO_DEADZONE);
        this.invertX = getStreamPref(StreamPref.GYRO_INVERT_X);
        this.invertY = getStreamPref(StreamPref.GYRO_INVERT_Y);

        this.updateRuntimeState();
        BxEventBus.Stream.emit('gyro.state.changed', { enabled: this.isEnabled() });
        BxEventBus.Stream.emit('gyro.updated', {});
    }

    async requestDevicePermissions(): Promise<boolean> {
        if (this.devicePermissionGranted) {
            return true;
        }

        let granted = true;
        try {
            const MotionEvt = (window as any).DeviceMotionEvent;
            if (MotionEvt && typeof MotionEvt.requestPermission === 'function') {
                const res = await MotionEvt.requestPermission();
                granted = granted && (res === 'granted');
            }

            const OrientEvt = (window as any).DeviceOrientationEvent;
            if (OrientEvt && typeof OrientEvt.requestPermission === 'function') {
                const res = await OrientEvt.requestPermission();
                granted = granted && (res === 'granted');
            }
        } catch (e) {
            BxLogger.warning(this.LOG_TAG, 'requestDevicePermissions', e);
        }

        this.devicePermissionGranted = granted;
        return granted;
    }

    async requestControllerHidAccess(): Promise<boolean> {
        const navHid = this.getNavHid();
        if (!navHid) {
            Toast.show(t('gyroscope'), t('browser-unsupported-feature'));
            return false;
        }

        try {
            const devices: any[] = await navHid.requestDevice({ filters: HID_FILTERS });
            if (!devices || devices.length === 0) {
                return false;
            }

            for (const device of devices) {
                await this.openHidDevice(device);
            }

            BxEventBus.Stream.emit('gyro.sensor.status', {});
            Toast.show(t('gyroscope'), `${t('controller')}: ${t('connected')}`, { instant: true });
            return true;
        } catch (e) {
            BxLogger.error(this.LOG_TAG, 'requestControllerHidAccess', e);
            return false;
        }
    }

    async toggle(force?: boolean): Promise<boolean> {
        const targetEnable = typeof force === 'boolean' ? force : !this.isEnabled();

        if (targetEnable) {
            await this.requestDevicePermissions();

            // If user explicitly chose Controller source and WebHID is available without an active controller sensor yet, prompt pairing
            if (this.source === GyroSource.CONTROLLER && this.hasWebHidSupport() && this.openedHidDevices.size === 0) {
                const status = this.getSensorStatus();
                if (!status.controllerGyroActive) {
                    await this.requestControllerHidAccess();
                }
            }
        }

        const newMode = targetEnable ? (this.lastActiveNonOffMode || GyroMode.ON) : GyroMode.OFF;
        setStreamPref(StreamPref.GYRO_MODE, newMode, 'direct');
        this.refreshSettings();

        if (targetEnable) {
            this.recalibrate(false);
        } else {
            this.resetStickToNeutral();
        }

        const stickLabel = this.stick === GyroStick.LS ? t('left-stick') : t('right-stick');
        const statusMsg = targetEnable ? `${t('enabled')} (${stickLabel})` : t('disabled');
        Toast.show(`🎯 ${t('gyroscope')}`, statusMsg, { instant: true });

        return targetEnable;
    }

    switchTargetStick(): GyroStick {
        const nextStick = this.stick === GyroStick.RS ? GyroStick.LS : GyroStick.RS;

        // Reset previous stick before switching
        this.resetStickToNeutral();

        setStreamPref(StreamPref.GYRO_STICK, nextStick, 'direct');
        this.refreshSettings();
        this.recalibrate(false);

        const stickLabel = nextStick === GyroStick.LS ? t('gyro-left-stick-racing') : t('gyro-right-stick-aim');
        Toast.show(`🎯 ${t('gyroscope')}`, stickLabel, { instant: true });
        return nextStick;
    }

    recalibrate(showToast = true) {
        const sample = this.selectActiveSample();
        if (sample) {
            const { rollDeg, pitchDeg } = this.computeTiltAngles(sample);
            this.neutralRollDeg = rollDeg;
            this.neutralPitchDeg = pitchDeg;
            this.needsRecenter = false;

            sample.biasRight = sample.aimRightRate;
            sample.biasUp = sample.aimUpRate;
            sample.biasRoll = sample.rollRightRate;
        } else {
            this.needsRecenter = true;
        }

        this.smoothX = 0;
        this.smoothY = 0;

        if (showToast) {
            Toast.show(`🎯 ${t('gyroscope')}`, t('gyro-recentered'), { instant: true });
        }
    }

    feedExternalSample = (data: ExternalGyroSample) => {
        const isController = data.source !== 'device';
        const target = isController ? this.controllerState : this.deviceState;

        if (isController) {
            this.activeControllerMethod = 'bridge';
        }

        const rightRate = -(data.wy ?? 0);
        const upRate = data.wx ?? 0;
        const rollRate = -(data.wz ?? 0);

        this.updateBiasAndRates(target, rightRate, upRate, rollRate);

        if (typeof data.gx === 'number' && typeof data.gy === 'number' && typeof data.gz === 'number') {
            target.gx = data.gx;
            target.gy = data.gy;
            target.gz = data.gz;
            target.hasGravity = true;
        }

        target.lastTimestamp = performance.now();
    }

    private updateBiasAndRates(state: SampleState, rightRate: number, upRate: number, rollRate: number) {
        const mag = Math.abs(rightRate) + Math.abs(upRate) + Math.abs(rollRate);
        if (mag < 3.5) {
            state.stillFrames++;
            if (state.stillFrames > 20) {
                const alpha = 0.03;
                state.biasRight += (rightRate - state.biasRight) * alpha;
                state.biasUp += (upRate - state.biasUp) * alpha;
                state.biasRoll += (rollRate - state.biasRoll) * alpha;
            }
        } else {
            state.stillFrames = 0;
        }

        state.aimRightRate = rightRate - state.biasRight;
        state.aimUpRate = upRate - state.biasUp;
        state.rollRightRate = rollRate - state.biasRoll;
    }

    private getScreenAngleRad(): number {
        let angle = 0;
        if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
            angle = window.screen.orientation.angle;
        } else if (typeof (window as any).orientation === 'number') {
            angle = (window as any).orientation;
        }
        return (angle * Math.PI) / 180;
    }

    private onDeviceMotion = (e: DeviceMotionEvent) => {
        const now = performance.now();
        const rad = this.getScreenAngleRad();
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);

        const rot = e.rotationRate;
        if (rot && (rot.alpha !== null || rot.beta !== null || rot.gamma !== null)) {
            this.hasNativeRotationRate = true;
            // rotationRate is in deg/s. Browsers (Chromium, WebKit, Gecko) expose the raw gyroscope axes as
            // alpha = X, beta = Y, gamma = Z, which is NOT the Z/X/Y order of DeviceOrientationEvent's angles.
            const wx = rot.alpha || 0;
            const wy = rot.beta || 0;
            const wz = rot.gamma || 0;

            const scrWx = cosA * wx - sinA * wy;
            const scrWy = sinA * wx + cosA * wy;
            const scrWz = wz;

            // Right-handed rotations, looking at the screen (+X right, +Y up, +Z toward user):
            // Aiming right = -scrWy, Aiming up = +scrWx, Rolling clockwise = -scrWz
            this.updateBiasAndRates(this.deviceState, -scrWy, scrWx, -scrWz);
            this.deviceState.lastTimestamp = now;
        }

        const acc = e.accelerationIncludingGravity;
        if (acc && (acc.x !== null || acc.y !== null || acc.z !== null)) {
            // iOS WebKit historically inverts accelerationIncludingGravity sign compared to Android/W3C
            const iosSign = UserAgent.isSafari() ? -1 : 1;
            const ax = (acc.x || 0) * iosSign;
            const ay = (acc.y || 0) * iosSign;
            const az = (acc.z || 0) * iosSign;

            const scrGx = cosA * ax - sinA * ay;
            const scrGy = sinA * ax + cosA * ay;
            const scrGz = az;

            const norm = Math.sqrt(scrGx * scrGx + scrGy * scrGy + scrGz * scrGz);
            if (norm > 1.0) {
                // Light gravity filter to reject high-frequency tap shake without adding steering lag
                const smooth = this.deviceState.hasGravity ? 0.55 : 1.0;
                this.deviceState.gx += (scrGx / norm - this.deviceState.gx) * smooth;
                this.deviceState.gy += (scrGy / norm - this.deviceState.gy) * smooth;
                this.deviceState.gz += (scrGz / norm - this.deviceState.gz) * smooth;
                this.deviceState.hasGravity = true;
                this.deviceState.lastTimestamp = now;

                if (this.needsRecenter) {
                    this.recalibrate(false);
                }
            }
        }
    }

    private onDeviceOrientation = (e: DeviceOrientationEvent) => {
        if (e.alpha === null && e.beta === null && e.gamma === null) {
            return;
        }

        const now = performance.now();
        const alpha = e.alpha || 0;
        const beta = e.beta || 0;
        const gamma = e.gamma || 0;

        const rad = this.getScreenAngleRad();
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);

        // Fallback tilt angles if accelerationIncludingGravity is absent
        const scrPitch = cosA * beta - sinA * gamma;
        const scrRoll = cosA * gamma + sinA * beta;
        this.deviceState.fallbackRollDeg = scrRoll;
        this.deviceState.fallbackPitchDeg = -scrPitch;
        this.deviceState.hasFallbackAngles = true;

        // Fallback angular velocity derivative for devices lacking rotationRate
        if (!this.hasNativeRotationRate && this.prevOrientTime > 0) {
            const dt = (now - this.prevOrientTime) / 1000;
            if (dt > 0.002 && dt < 0.25 && this.prevOrientAlpha !== null && this.prevOrientBeta !== null && this.prevOrientGamma !== null) {
                const dAlpha = unwrapAngleDelta(alpha, this.prevOrientAlpha) / dt;
                const dBeta = unwrapAngleDelta(beta, this.prevOrientBeta) / dt;
                const dGamma = unwrapAngleDelta(gamma, this.prevOrientGamma) / dt;

                const scrWx = cosA * dBeta - sinA * dGamma;
                const scrWy = sinA * dBeta + cosA * dGamma;
                this.updateBiasAndRates(this.deviceState, -scrWy, scrWx, -dAlpha);
            }
        }

        this.prevOrientAlpha = alpha;
        this.prevOrientBeta = beta;
        this.prevOrientGamma = gamma;
        this.prevOrientTime = now;
        this.deviceState.lastTimestamp = now;

        if (this.needsRecenter && !this.deviceState.hasGravity) {
            this.recalibrate(false);
        }
    }

    private startDeviceListeners() {
        if (this.deviceListening || !this.hasDeviceSensorSupport()) {
            return;
        }
        this.deviceListening = true;
        window.addEventListener('devicemotion', this.onDeviceMotion, { passive: true });
        window.addEventListener('deviceorientation', this.onDeviceOrientation, { passive: true });
    }

    private stopDeviceListeners() {
        if (!this.deviceListening) {
            return;
        }
        this.deviceListening = false;
        window.removeEventListener('devicemotion', this.onDeviceMotion);
        window.removeEventListener('deviceorientation', this.onDeviceOrientation);
        this.prevOrientTime = 0;
    }

    private async initWebHidAutoConnect() {
        const navHid = this.getNavHid();
        if (!navHid) {
            return;
        }

        try {
            const devices: any[] = await navHid.getDevices();
            for (const device of devices) {
                if (this.isSupportedHidDevice(device)) {
                    await this.openHidDevice(device);
                }
            }

            navHid.addEventListener('connect', async (e: any) => {
                if (e.device && this.isSupportedHidDevice(e.device)) {
                    await this.openHidDevice(e.device);
                    BxEventBus.Stream.emit('gyro.sensor.status', {});
                }
            });

            navHid.addEventListener('disconnect', (e: any) => {
                if (e.device && this.openedHidDevices.has(e.device)) {
                    this.openedHidDevices.delete(e.device);
                    if (this.openedHidDevices.size === 0) {
                        this.activeControllerName = null;
                        if (this.activeControllerMethod === 'webhid') {
                            this.activeControllerMethod = null;
                        }
                    }
                    BxEventBus.Stream.emit('gyro.sensor.status', {});
                }
            });
        } catch (e) {
            BxLogger.warning(this.LOG_TAG, 'initWebHidAutoConnect', e);
        }
    }

    private isSupportedHidDevice(device: any): boolean {
        return HID_FILTERS.some(f => f.vendorId === device.vendorId && f.productId === device.productId);
    }

    private async sendSwitchSubcommand(device: any, subcommand: number, arg: number) {
        const buf = new Uint8Array(11);
        buf[0] = (this.switchPacketNumber++) & 0x0f;
        // Neutral rumble bytes
        buf[1] = 0x00; buf[2] = 0x01; buf[3] = 0x40; buf[4] = 0x40;
        buf[5] = 0x00; buf[6] = 0x01; buf[7] = 0x40; buf[8] = 0x40;
        buf[9] = subcommand;
        buf[10] = arg;
        await device.sendReport(0x01, buf);
    }

    private async openHidDevice(device: any) {
        if (!device || this.openedHidDevices.has(device)) {
            return;
        }

        try {
            if (!device.opened) {
                await device.open();
            }

            // Trigger full Bluetooth IMU reports on Sony & Nintendo controllers
            if (device.vendorId === 0x054c) {
                if (device.productId === 0x0ce6 || device.productId === 0x0df2) {
                    // DualSense / DualSense Edge: reading feature report 0x05 enables BT report 0x31
                    await device.receiveFeatureReport(0x05).catch(() => {});
                } else {
                    // DualShock 4: reading feature report 0x02 enables BT report 0x11
                    await device.receiveFeatureReport(0x02).catch(() => {});
                }
            } else if (device.vendorId === 0x057e) {
                // Switch Pro / Joy-Con: enable IMU (0x40 = 1) and full report mode (0x03 = 0x30)
                await this.sendSwitchSubcommand(device, 0x40, 0x01).catch(() => {});
                await this.sendSwitchSubcommand(device, 0x03, 0x30).catch(() => {});
            }

            device.addEventListener('inputreport', this.onHidInputReport);
            this.openedHidDevices.add(device);
            this.activeControllerMethod = 'webhid';
            this.activeControllerName = device.productName || 'HID Controller';
            BxLogger.info(this.LOG_TAG, 'Opened WebHID gyro controller:', this.activeControllerName);
        } catch (e) {
            BxLogger.warning(this.LOG_TAG, 'Failed to open WebHID controller', e);
        }
    }

    private onHidInputReport = (e: any) => {
        const data: DataView = e.data;
        const reportId: number = e.reportId;
        const device = e.device;
        if (!data || !device) {
            return;
        }
        this.hidReportCount++;
        this.hidLastReportId = reportId;

        let gxRaw = 0, gyRaw = 0, gzRaw = 0;
        let axRaw = 0, ayRaw = 0, azRaw = 0;
        let gyroScale = 16.384; // LSB per deg/s (~2000 dps full scale)
        let accelScale = 8192;  // LSB per g
        let valid = false;

        if (device.vendorId === 0x054c) {
            const isDualSense = device.productId === 0x0ce6 || device.productId === 0x0df2;
            if (isDualSense) {
                if (reportId === 0x01 && data.byteLength >= 27) {
                    // DualSense USB
                    gxRaw = data.getInt16(15, true);
                    gyRaw = data.getInt16(17, true);
                    gzRaw = data.getInt16(19, true);
                    axRaw = data.getInt16(21, true);
                    ayRaw = data.getInt16(23, true);
                    azRaw = data.getInt16(25, true);
                    valid = true;
                } else if (reportId === 0x31 && data.byteLength >= 28) {
                    // DualSense Bluetooth
                    gxRaw = data.getInt16(16, true);
                    gyRaw = data.getInt16(18, true);
                    gzRaw = data.getInt16(20, true);
                    axRaw = data.getInt16(22, true);
                    ayRaw = data.getInt16(24, true);
                    azRaw = data.getInt16(26, true);
                    valid = true;
                }
            } else {
                // DualShock 4
                if (reportId === 0x01 && data.byteLength >= 24) {
                    // DS4 USB
                    gxRaw = data.getInt16(12, true);
                    gyRaw = data.getInt16(14, true);
                    gzRaw = data.getInt16(16, true);
                    axRaw = data.getInt16(18, true);
                    ayRaw = data.getInt16(20, true);
                    azRaw = data.getInt16(22, true);
                    valid = true;
                } else if (reportId === 0x11 && data.byteLength >= 26) {
                    // DS4 Bluetooth
                    gxRaw = data.getInt16(14, true);
                    gyRaw = data.getInt16(16, true);
                    gzRaw = data.getInt16(18, true);
                    axRaw = data.getInt16(20, true);
                    ayRaw = data.getInt16(22, true);
                    azRaw = data.getInt16(24, true);
                    valid = true;
                }
            }
        } else if (device.vendorId === 0x057e && reportId === 0x30 && data.byteLength >= 24) {
            // Switch Pro Controller / Joy-Con (+X forward, +Y left, +Z up -> map to +X right, +Y up, +Z player)
            const swAx = data.getInt16(12, true);
            const swAy = data.getInt16(14, true);
            const swAz = data.getInt16(16, true);
            const swGx = data.getInt16(18, true);
            const swGy = data.getInt16(20, true);
            const swGz = data.getInt16(22, true);

            // The browser's own Gamepad driver switches the IMU off when it sets the controller up, which can
            // happen after we enabled it. A real sensor never reads exactly zero on all six axes (gravity alone
            // shows up on the accelerometer), so that means "IMU disabled": turn it back on.
            if (!swAx && !swAy && !swAz && !swGx && !swGy && !swGz) {
                const now = performance.now();
                if (++this.hidZeroImuStreak > 30 && now - this.hidImuEnableAt > 1000) {
                    this.hidImuEnableAt = now;
                    this.hidImuEnableCount++;
                    this.sendSwitchSubcommand(device, 0x40, 0x01).catch(() => {});
                }
                return;
            }
            this.hidZeroImuStreak = 0;

            gxRaw = -swGy;
            gyRaw = swGz;
            gzRaw = -swGx;
            axRaw = -swAy;
            ayRaw = swAz;
            azRaw = -swAx;
            gyroScale = 14.285;
            accelScale = 4096;
            valid = true;
        }

        if (!valid) {
            return;
        }

        // Convert to deg/s and normalized g
        const wx = gxRaw / gyroScale;
        const wy = gyRaw / gyroScale;
        const wz = gzRaw / gyroScale;

        this.updateBiasAndRates(this.controllerState, -wy, wx, -wz);

        const ax = axRaw / accelScale;
        const ay = ayRaw / accelScale;
        const az = azRaw / accelScale;
        const norm = Math.sqrt(ax * ax + ay * ay + az * az);
        if (norm > 0.2) {
            const smooth = this.controllerState.hasGravity ? 0.55 : 1.0;
            this.controllerState.gx += (ax / norm - this.controllerState.gx) * smooth;
            this.controllerState.gy += (ay / norm - this.controllerState.gy) * smooth;
            this.controllerState.gz += (az / norm - this.controllerState.gz) * smooth;
            this.controllerState.hasGravity = true;

            if (this.needsRecenter) {
                this.recalibrate(false);
            }
        }

        this.controllerState.lastTimestamp = performance.now();
    }

    private pollGamepadMotionSensors() {
        // Skip if WebHID is already delivering high-rate IMU data
        if (this.openedHidDevices.size > 0) {
            return;
        }

        const gamepads = window.navigator.getGamepads ? window.navigator.getGamepads() : [];
        for (const gp of gamepads) {
            if (!gp || !gp.connected) {
                continue;
            }

            // Case 1: Dedicated Motion Sensors sub-device (e.g. Linux/Android hid-playstation)
            if (GyroManager.isMotionSensorSubGamepad(gp) && gp.axes.length >= 6) {
                const ax = gp.axes[0] || 0;
                const ay = gp.axes[1] || 0;
                const az = gp.axes[2] || 0;
                // Linux hid-playstation scales EV_ABS gyro over +-2000 deg/s
                const wx = (gp.axes[3] || 0) * 2000;
                const wy = (gp.axes[4] || 0) * 2000;
                const wz = (gp.axes[5] || 0) * 2000;

                this.updateBiasAndRates(this.controllerState, -wy, wx, -wz);

                const norm = Math.sqrt(ax * ax + ay * ay + az * az);
                if (norm > 0.05) {
                    const smooth = this.controllerState.hasGravity ? 0.25 : 1.0;
                    this.controllerState.gx += (ax / norm - this.controllerState.gx) * smooth;
                    this.controllerState.gy += (ay / norm - this.controllerState.gy) * smooth;
                    this.controllerState.gz += (az / norm - this.controllerState.gz) * smooth;
                    this.controllerState.hasGravity = true;
                }

                this.activeControllerMethod = 'gamepad';
                this.activeControllerName = gp.id;
                this.controllerState.lastTimestamp = performance.now();
                if (this.needsRecenter) {
                    this.recalibrate(false);
                }
                return;
            }

            // Case 2: Gamepad Pose API (VR / Firefox / extended browsers)
            const pose = (gp as any).pose;
            if (pose && pose.angularVelocity) {
                const radToDeg = 180 / Math.PI;
                const wx = (pose.angularVelocity[0] || 0) * radToDeg;
                const wy = (pose.angularVelocity[1] || 0) * radToDeg;
                const wz = (pose.angularVelocity[2] || 0) * radToDeg;
                this.updateBiasAndRates(this.controllerState, -wy, wx, -wz);
                this.activeControllerMethod = 'gamepad';
                this.activeControllerName = gp.id;
                this.controllerState.lastTimestamp = performance.now();
                return;
            }
        }
    }

    private selectActiveSample(): SampleState | null {
        const now = performance.now();
        const controllerFresh = this.controllerState.lastTimestamp > 0 && (now - this.controllerState.lastTimestamp < 1500);
        const deviceFresh = this.deviceState.lastTimestamp > 0 && (now - this.deviceState.lastTimestamp < 1500);

        if (this.source === GyroSource.CONTROLLER) {
            return controllerFresh ? this.controllerState : null;
        }

        if (this.source === GyroSource.DEVICE) {
            return deviceFresh ? this.deviceState : null;
        }

        // AUTO: prefer controller gyro if actively streaming samples, else device gyro
        if (controllerFresh) {
            return this.controllerState;
        }
        if (deviceFresh) {
            return this.deviceState;
        }
        return null;
    }

    private computeTiltAngles(sample: SampleState): { rollDeg: number; pitchDeg: number } {
        if (sample.hasGravity) {
            const radToDeg = 180 / Math.PI;
            // Gimbal-lock-free steering roll angle (-gx > 0 when rolled clockwise / right)
            const yzMag = Math.sqrt(sample.gy * sample.gy + sample.gz * sample.gz);
            const rollDeg = Math.atan2(-sample.gx, Math.max(0.001, yzMag)) * radToDeg;
            // Pitch angle relative to YZ plane (tilting forward away from user increases pitch)
            const pitchDeg = Math.atan2(-sample.gz, sample.gy) * radToDeg;
            return { rollDeg, pitchDeg };
        }

        if (sample.hasFallbackAngles) {
            return {
                rollDeg: sample.fallbackRollDeg,
                pitchDeg: sample.fallbackPitchDeg,
            };
        }

        return { rollDeg: 0, pitchDeg: 0 };
    }

    private shouldApplyGyro(baseGamepad: XcloudGamepad): boolean {
        this.pauseReason = '';
        if (!STATES.isPlaying || this.mode === GyroMode.OFF) {
            this.pauseReason = this.mode === GyroMode.OFF ? 'mode off' : 'not playing';
            return false;
        }

        // Pause gyro injection while in Guide / Stream Menu / Better xCloud Dialog so menus don't drift
        if (window.BX_STREAM_SETTINGS?.xCloudPollingMode && window.BX_STREAM_SETTINGS.xCloudPollingMode !== 'none') {
            this.pauseReason = 'menu (' + window.BX_STREAM_SETTINGS.xCloudPollingMode + ')';
            return false;
        }
        if (this.isDialogOpen || window.BX_EXPOSED?.disableGamepadPolling) {
            this.pauseReason = this.isDialogOpen ? 'dialog' : 'polling disabled';
            return false;
        }

        if (this.mode === GyroMode.ON) {
            return true;
        }

        // Check triggers from both xCloud packet and live physical gamepad
        let lt = baseGamepad.LeftTrigger || 0;
        let rt = baseGamepad.RightTrigger || 0;

        const gamepads = window.navigator.getGamepads ? window.navigator.getGamepads() : [];
        for (const gp of gamepads) {
            if (gp && gp.connected && !GyroManager.isMotionSensorSubGamepad(gp) && gp.buttons.length >= 8) {
                lt = Math.max(lt, gp.buttons[6]?.value || 0);
                rt = Math.max(rt, gp.buttons[7]?.value || 0);
                break;
            }
        }

        if (this.mode === GyroMode.LT) {
            return lt >= 0.2;
        }

        if (this.mode === GyroMode.RT) {
            return rt >= 0.2;
        }

        return false;
    }

    private computeStickOutput(): [number, number] {
        this.pollGamepadMotionSensors();

        const sample = this.selectActiveSample();
        if (!sample) {
            return [0, 0];
        }
        this.outputFromController = sample === this.controllerState;

        const effectiveBehavior = this.behavior === GyroBehavior.AUTO
            ? (this.stick === GyroStick.LS ? GyroBehavior.TILT : GyroBehavior.MOTION)
            : this.behavior;

        const effectiveAxes = this.axes === GyroAxes.AUTO
            ? (this.stick === GyroStick.LS && effectiveBehavior === GyroBehavior.TILT ? GyroAxes.HORIZONTAL : GyroAxes.BOTH)
            : this.axes;

        const sensX = this.sensitivityX / 100;
        const sensY = this.sensitivityY / 100;
        const dzNorm = this.deadzone / 100;

        let rawX = 0;
        let rawY = 0;

        if (effectiveBehavior === GyroBehavior.TILT) {
            const { rollDeg, pitchDeg } = this.computeTiltAngles(sample);
            const deltaRoll = unwrapAngleDelta(rollDeg, this.neutralRollDeg);
            const deltaPitch = unwrapAngleDelta(pitchDeg, this.neutralPitchDeg);

            // At 100% sensitivity, 45 degrees tilt = 1.0 full steering lock
            const fullLockDeg = 45;
            rawX = (deltaRoll / fullLockDeg) * sensX;
            rawY = (deltaPitch / fullLockDeg) * sensY;

            // Apply deadzone smoothly without abrupt jump for racing precision
            const applyTiltDeadzone = (v: number): number => {
                const abs = Math.abs(v);
                if (abs <= dzNorm) {
                    return 0;
                }
                const sign = v < 0 ? -1 : 1;
                return sign * clamp((abs - dzNorm) / Math.max(0.01, 1 - dzNorm), 0, 1);
            };

            rawX = applyTiltDeadzone(rawX);
            rawY = applyTiltDeadzone(rawY);
        } else {
            // Motion / Angular Velocity mode (Aiming / Camera)
            let horizDegPerSec: number;
            if (sample === this.deviceState && sample.hasGravity) {
                // Turn rate around the real-world vertical axis (angular velocity projected onto gravity),
                // so turning left/right works the same whether the phone is held upright, tilted back or flat
                horizDegPerSec = sample.aimRightRate * sample.gy + sample.rollRightRate * sample.gz - sample.aimUpRate * sample.gx;
            } else {
                // Combine yaw + 0.45 * roll so natural wrist turns feel responsive at any holding angle
                horizDegPerSec = sample.aimRightRate + 0.45 * sample.rollRightRate;
            }
            const vertDegPerSec = sample.aimUpRate;

            // At 100% sensitivity, 85 deg/s = 1.0 stick deflection
            const fullScaleDps = 85;
            rawX = (horizDegPerSec / fullScaleDps) * sensX;
            rawY = (vertDegPerSec / fullScaleDps) * sensY;

            const mag = Math.sqrt(rawX * rawX + rawY * rawY);
            const motionNoiseGate = Math.max(0.008, dzNorm * 0.5);
            if (mag < motionNoiseGate) {
                rawX = 0;
                rawY = 0;
            } else {
                // Subtle deadzone counterweight (0.08) so games with internal stick deadzones respond immediately to fine aiming
                const counterweight = 0.08;
                const rescaled = counterweight + ((mag - motionNoiseGate) / Math.max(0.01, 1 - motionNoiseGate)) * (1 - counterweight);
                const clampedMag = Math.min(1, rescaled);
                const scale = clampedMag / mag;
                rawX *= scale;
                rawY *= scale;
            }
        }

        if (effectiveAxes === GyroAxes.HORIZONTAL) {
            rawY = 0;
        } else if (effectiveAxes === GyroAxes.VERTICAL) {
            rawX = 0;
        }

        if (this.invertX) {
            rawX = -rawX;
        }
        if (this.invertY) {
            rawY = -rawY;
        }

        // Light low-pass smoothing for jitter-free stick output
        const smoothFactor = effectiveBehavior === GyroBehavior.TILT ? 0.65 : 0.7;
        this.smoothX = Math.abs(rawX) < 0.001 && Math.abs(this.smoothX) < 0.005 ? 0 : (this.smoothX + (rawX - this.smoothX) * smoothFactor);
        this.smoothY = Math.abs(rawY) < 0.001 && Math.abs(this.smoothY) < 0.005 ? 0 : (this.smoothY + (rawY - this.smoothY) * smoothFactor);

        return [clamp(this.smoothX, -1, 1), clamp(this.smoothY, -1, 1)];
    }

    private ensureInputChannelHooked(): any {
        const channel = window.BX_EXPOSED?.inputChannel as any;
        if (channel && typeof channel.sendGamepadInput === 'function' && !channel._bxGyroHooked) {
            const origSend = channel.sendGamepadInput.bind(channel);
            channel._bxOrigSendGamepadInput = origSend;
            channel._bxGyroHooked = true;

            channel.sendGamepadInput = (timestamp: number, gamepads: XcloudGamepad[]) => {
                return this.interceptSendGamepadInput(origSend, timestamp, gamepads);
            };
            BxLogger.info(this.LOG_TAG, 'Hooked inputChannel.sendGamepadInput');
        }
        return channel;
    }

    private ensureVirtualControllerRegistered() {
        if (this.hasSeenGamepadPacket || this.virtualConnectedOnce) {
            return;
        }

        const streamSession = window.BX_EXPOSED?.streamSession;
        if (streamSession && typeof streamSession.onVirtualGamepadInput === 'function') {
            this.virtualConnectedOnce = true;
            const connectFrame = generateVirtualControllerMapping(0, { VirtualPhysicality: 1 });
            const idleFrame = generateVirtualControllerMapping(0, { VirtualPhysicality: 0 });
            streamSession.onVirtualGamepadInput('bxGyro', performance.now(), [connectFrame]);
            streamSession.onVirtualGamepadInput('bxGyro', performance.now(), [idleFrame]);
        }
    }

    private interceptSendGamepadInput(origSend: (ts: number, gps: XcloudGamepad[]) => void, timestamp: number, gamepads: XcloudGamepad[]) {
        if (!gamepads || gamepads.length === 0) {
            return origSend(timestamp, gamepads);
        }

        // Find Player 1 / slot 0 gamepad
        let targetIdx = 0;
        for (let i = 0; i < gamepads.length; i++) {
            if (gamepads[i].GamepadIndex === 0) {
                targetIdx = i;
                break;
            }
        }

        const baseGp = gamepads[targetIdx];
        this.lastBaseGamepad = Object.assign({}, baseGp);
        this.hasSeenGamepadPacket = true;
        this.lastExternalPacketTime = performance.now();

        const active = this.shouldApplyGyro(this.lastBaseGamepad);
        if (active && !this.wasApplyingGyro) {
            // Auto-recenter tilt when LT/RT trigger activates gyro
            if (this.mode === GyroMode.LT || this.mode === GyroMode.RT) {
                this.recalibrate(false);
            }
        }
        this.wasApplyingGyro = active;

        if (!active) {
            this.lastSentGx = 0;
            this.lastSentGy = 0;
            return origSend(timestamp, gamepads);
        }

        const [gx, gy] = this.computeStickOutput();
        this.lastSentGx = gx;
        this.lastSentGy = gy;

        if (gx === 0 && gy === 0) {
            return origSend(timestamp, gamepads);
        }

        const modifiedGp = this.buildGyroPacket(baseGp, gx, gy);
        this.injectedPacketCount++;

        const outGamepads = gamepads.slice();
        outGamepads[targetIdx] = modifiedGp;
        return origSend(timestamp, outGamepads);
    }

    private buildGyroPacket(base: XcloudGamepad, gx: number, gy: number): XcloudGamepad {
        const packet: XcloudGamepad = Object.assign({}, base);
        packet.Dirty = true;

        let stickBits: number;
        if (this.stick === GyroStick.LS) {
            packet.LeftThumbXAxis = clamp((base.LeftThumbXAxis || 0) + gx, -1, 1);
            packet.LeftThumbYAxis = clamp((base.LeftThumbYAxis || 0) + gy, -1, 1);
            stickBits = PHYSICALITY_LEFT_STICK;
        } else {
            packet.RightThumbXAxis = clamp((base.RightThumbXAxis || 0) + gx, -1, 1);
            packet.RightThumbYAxis = clamp((base.RightThumbYAxis || 0) + gy, -1, 1);
            stickBits = PHYSICALITY_RIGHT_STICK;
        }

        if (gx !== 0 || gy !== 0) {
            // Report the stick the same way its real source would: the device's own gyro behaves like the
            // on-screen touch stick, a controller's gyro like that controller's stick
            if (this.outputFromController) {
                packet.PhysicalPhysicality = (base.PhysicalPhysicality || 0) | stickBits;
            } else {
                packet.VirtualPhysicality = (base.VirtualPhysicality || 0) | stickBits;
            }
        }

        return packet;
    }

    private resetStickToNeutral() {
        this.smoothX = 0;
        this.smoothY = 0;

        const channel = this.ensureInputChannelHooked();
        const origSend = channel?._bxOrigSendGamepadInput;
        if (origSend && (this.lastSentGx !== 0 || this.lastSentGy !== 0)) {
            this.lastSentGx = 0;
            this.lastSentGy = 0;
            const neutralPacket: XcloudGamepad = Object.assign({}, this.lastBaseGamepad, { Dirty: true });
            origSend(performance.now(), [neutralPacket]);
        }
    }

    private onAnimationFrame = () => {
        if (!STATES.isPlaying || this.mode === GyroMode.OFF) {
            this.rafId = null;
            return;
        }

        this.rafId = window.requestAnimationFrame(this.onAnimationFrame);

        const channel = this.ensureInputChannelHooked();
        const origSend = channel?._bxOrigSendGamepadInput;
        if (!origSend) {
            return;
        }

        const now = performance.now();
        // If xCloud already sent an external gamepad packet within the last 10ms, interceptSendGamepadInput already injected gyro
        if (now - this.lastExternalPacketTime < 10) {
            return;
        }

        const active = this.shouldApplyGyro(this.lastBaseGamepad);
        if (active && !this.wasApplyingGyro) {
            if (this.mode === GyroMode.LT || this.mode === GyroMode.RT) {
                this.recalibrate(false);
            }
        }

        if (!active) {
            if (this.wasApplyingGyro) {
                this.wasApplyingGyro = false;
                this.resetStickToNeutral();
            }
            return;
        }

        this.wasApplyingGyro = true;
        const [gx, gy] = this.computeStickOutput();

        const deltaChanged = Math.abs(gx - this.lastSentGx) > 0.002 || Math.abs(gy - this.lastSentGy) > 0.002;
        const nonZero = gx !== 0 || gy !== 0;

        if (!deltaChanged && !nonZero) {
            return;
        }

        this.ensureVirtualControllerRegistered();

        const packet = this.buildGyroPacket(this.lastBaseGamepad, gx, gy);

        this.lastSentGx = gx;
        this.lastSentGy = gy;
        this.injectedPacketCount++;
        origSend(now, [packet]);
    }

    private updateRuntimeState() {
        // Notify optional native Android bridge if available
        if (AppInterface && typeof (AppInterface as any).setGyroEnabled === 'function') {
            try {
                (AppInterface as any).setGyroEnabled(this.isEnabled());
            } catch (e) {}
        }

        if (STATES.isPlaying && this.mode !== GyroMode.OFF) {
            if (this.source !== GyroSource.CONTROLLER) {
                this.startDeviceListeners();
            } else {
                this.stopDeviceListeners();
            }

            this.ensureInputChannelHooked();
            if (this.rafId === null) {
                this.rafId = window.requestAnimationFrame(this.onAnimationFrame);
            }
        } else {
            this.stopDeviceListeners();
            if (this.rafId !== null) {
                window.cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
        }
    }

    reset() {
        this.stopDeviceListeners();
        if (this.rafId !== null) {
            window.cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.smoothX = 0;
        this.smoothY = 0;
        this.lastSentGx = 0;
        this.lastSentGy = 0;
        this.wasApplyingGyro = false;
        this.hasSeenGamepadPacket = false;
        this.virtualConnectedOnce = false;
        this.lastBaseGamepad = generateVirtualControllerMapping(0);
        this.needsRecenter = true;
    }

    private setupEvents() {
        BxEventBus.Stream.on('state.playing', () => {
            this.hasSeenGamepadPacket = false;
            this.virtualConnectedOnce = false;
            this.lastBaseGamepad = generateVirtualControllerMapping(0);
            this.needsRecenter = true;
            this.ensureInputChannelHooked();
            this.refreshSettings();
        });

        BxEventBus.Stream.on('state.stopped', () => {
            this.reset();
        });

        BxEventBus.Script.on('dialog.shown', () => {
            this.isDialogOpen = true;
        });
        BxEventBus.Script.on('dialog.dismissed', () => {
            this.isDialogOpen = false;
        });

        window.addEventListener('gamepadconnected', () => {
            BxEventBus.Stream.emit('gyro.sensor.status', {});
        });
        window.addEventListener('gamepaddisconnected', () => {
            BxEventBus.Stream.emit('gyro.sensor.status', {});
        });
    }
}
