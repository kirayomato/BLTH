import BaseModule from '@/modules/BaseModule'
import { useModuleStore } from '@/stores'
import { unsafeWindow } from '$'

export default class Default_AutoRestart extends BaseModule {
  public static runOnMultiplePages: boolean = false
  public static runAt = 'document-body' as const
  public static onFrame = 'target' as const
  public static runAfterDefault: boolean = false

  protected set status(_s: never) { }

  public async run(): Promise<void> {
    if (!this.isEnabled() || !this.config) {
      return Promise.resolve()
    }

    const { intervalMinutes } = this.config

    if (typeof intervalMinutes !== 'number' || intervalMinutes <= 0) {
      return Promise.resolve()
    }

    const delay = intervalMinutes * 60 * 1000

    unsafeWindow.setTimeout(() => {
      unsafeWindow.location.reload()
    }, delay)

    return Promise.resolve()
  }

  constructor() {
    super('Default_AutoRestart')
    this.config = useModuleStore().moduleConfig.EnhanceExperience.autoRestart
  }
}
