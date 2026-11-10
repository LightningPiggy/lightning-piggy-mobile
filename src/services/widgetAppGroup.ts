// Android / web: the widget reads the snapshot from AsyncStorage directly, so
// there is no App Group to mirror into. See widgetAppGroup.ios.ts.

export function mirrorWidgetSnapshot(_json: string): void {}

export function wipeWidgetAppGroup(): void {}
