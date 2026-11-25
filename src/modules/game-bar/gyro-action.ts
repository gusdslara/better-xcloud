import { BxIcon } from "@utils/bx-icon";
import { createButton, ButtonStyle, CE } from "@utils/html";
import { BaseGameBarAction } from "./base-action";
import { t } from "@utils/translation";
import { GyroManager } from "../gyro-manager";
import { BxEventBus } from "@/utils/bx-event-bus";


export class GyroAction extends BaseGameBarAction {
    $content: HTMLElement;

    constructor() {
        super();

        const $btnOff = createButton({
            style: ButtonStyle.GHOST,
            icon: BxIcon.GYROSCOPE_OFF,
            title: `${t('gyroscope')} (${t('off')})`,
            onClick: this.onClick,
        });

        const $btnOn = createButton({
            style: ButtonStyle.GHOST,
            icon: BxIcon.GYROSCOPE,
            title: `${t('gyroscope')} (${t('on')})`,
            onClick: this.onClick,
            classes: ['bx-activated'],
        });

        this.$content = CE('div', false, $btnOff, $btnOn);
        this.$content.addEventListener('contextmenu', e => {
            e.preventDefault();
            GyroManager.getInstance().switchTargetStick();
        });

        BxEventBus.Stream.on('gyro.state.changed', payload => {
            this.$content.dataset.activated = payload.enabled.toString();
        });
    }

    onClick = (e: Event) => {
        super.onClick(e);
        GyroManager.getInstance().toggle();
    }

    reset(): void {
        this.$content.dataset.activated = GyroManager.getInstance().isEnabled().toString();
    }
}
