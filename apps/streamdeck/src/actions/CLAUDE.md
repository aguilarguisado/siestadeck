# apps/streamdeck/src/actions/ — Stream Deck action classes

Each file here is one Stream Deck action: a class extending `SingletonAction<TSettings>` decorated with `@action({ UUID: "io.github.aguilarguisado.siestadeck.<name>" })`. The UUID must match an entry in `io.github.aguilarguisado.siestadeck.sdPlugin/manifest.json`. Registration happens in `apps/streamdeck/src/plugin.ts:33-37` — add new actions to that list.

## The pattern (copy this shape)

```ts
@action({ UUID: "io.github.aguilarguisado.siestadeck.my-action" })
export class MyAction extends SingletonAction<MySettings> {
  private visible = new Map<string, Visible>();   // one entry per on-screen key

  constructor() {
    super();
    someService.on("snapshot", (snap) => {
      for (const v of this.visible.values()) void this.draw(v, snap);
    });
  }

  override async onWillAppear(ev) { /* register in this.visible, render cached snapshot */ }
  override onWillDisappear(ev)    { /* delete from this.visible, clear any per-key timers */ }
  override async onDidReceiveSettings(ev) { /* update settings, re-render */ }
  override onKeyDown(ev)          { /* trigger an explicit refresh / swap / etc. */ }
}
```

Reference implementation: `apps/streamdeck/src/actions/quotaMeter.ts:47-183`.

## The hard rules

1. **Never fetch, poll, or read files inside an action.** Subscribe to a service snapshot. The single quota meter lives at `quotaMeter.ts:52-55`; never inline equivalents elsewhere.
2. **Track `this.visible` by `action.id`**, not by some other key. `onWillAppear` may fire multiple times for multi-button setups (one event per physical key); each gets its own id.
3. **Lazy services require `.acquire(action.id)` in `onWillAppear` and `.release(action.id)` in `onWillDisappear`.** Applies to `activeSessionService` (see `apps/streamdeck/src/actions/activeModel.ts` for the consumer side). The `quotaRegistry` and `accountsService` are eager — no acquire needed.
4. **Clear per-key timers in `onWillDisappear`.** See the cooldown timer pattern at `quotaMeter.ts:151-182` (cleared at `quotaMeter.ts:70`) — a 1-second tick re-renders the "WAIT Xs" countdown badge during 429 backoff. Leaking these keeps the event loop alive after a key disappears.
5. **Don't call `setTitle()` with anything but `""`.** siestadeck renders text inside the SVG so it can use Helvetica + theme colors; Stream Deck's overlay title is always cleared (`quotaMeter.ts:62,80,103`).
6. **Render via `renderXxx(...)` (in `apps/streamdeck/src/render/svg.ts`) → `toImageUri(svg)` → `action.setImage(uri)`.** Don't construct SVG strings inline in actions.

## Settings

Settings are TypeScript types persisted by Stream Deck per-key. They arrive on `onWillAppear`, `onDidReceiveSettings`, and `onKeyDown` events. The Property Inspector HTML in `io.github.aguilarguisado.siestadeck.sdPlugin/pi/<action>.html` defines the form fields; field `name` attributes map to settings keys. PI form values come back as **strings** even for numeric inputs — coerce with `Number()` (see `quotaMeter.ts:91-95`).

## PI dropdowns (account pickers)

If your action needs an account dropdown, override `onSendToPlugin` and call `handleAccountDatasource(ev)` from `apps/streamdeck/src/piDatasources.ts`. That handler responds to `event: "getAccounts"` and `event: "getAccountsIncludingActive"` payloads from the PI. See `switchAccount.ts` for the consumer side; `piDatasources.ts:14-35` for the protocol.

## Auto-refresh opt-in

The quota service is silent by default — no network calls happen unless `enableAutoRefresh(slug, intervalMs)` is called or a user presses a key. The Quota Meter action exposes this as a per-key setting (`quotaMeter.ts:86-97`). Cadence is clamped to a 5-minute minimum inside the service.
