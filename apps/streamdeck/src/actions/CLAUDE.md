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

## Auto-refresh: on by default, refcounted per key

A key that shows quota asks the registry to keep it current for as long as it is on screen:

```ts
override async onWillAppear(ev) { quotaRegistry.requestAutoRefresh(ev.action.id, ms); }
override onWillDisappear(ev)    { quotaRegistry.releaseAutoRefresh(ev.action.id); }
```

Same acquire/release shape as `activeSessionService`, and the same rule: **release on disappear**, or an off-screen key keeps spending requests. The last release stops the polling.

- **`autoRefresh` is on unless the user unticked it.** `undefined` is a key that has never been opened in the Property Inspector, so `quotaMeter.ts` tests for `=== false`, not `!== true`. A gauge that is only correct in the second after you press it is not a gauge. The PI checkbox carries `default="true"` so it shows what the code does.
- **Opting out is a *release*, not a zero cadence.** Two quota keys where one had auto-refresh off used to mean neither polled — `enableAutoRefresh(null, 0)` from the second key switched off the first. The registry now runs the tightest cadence any *live* consumer asked for.
- **Cadence is clamped to ≥5 minutes** in the service, whatever the PI says, and automatic ticks are skipped entirely while Claude Code has been idle for 20+ minutes.
- **One timer serves every key.** `ExtraUsage` requests the same 15-minute default with no PI of its own, so an extra-usage-only deck still updates; a deck with both keys polls once for the pair.
- **A key press is still a manual refresh**, throttled by core's 5s floor. Don't add per-action throttling on top — it is already there, per account.
