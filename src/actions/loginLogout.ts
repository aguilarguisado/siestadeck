import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { toImageUri } from "../render/rasterize.js";
import { openTerminalWithCommand } from "../services/terminal.js";
import { accountsService } from "../services/accounts.js";
import { drawLoginLogout, type LoginLogoutMode } from "./draw/loginLogout.js";

type Settings = { mode?: LoginLogoutMode; displayName?: string };

@action({ UUID: "io.github.aguilarguisado.siestadeck.login-logout" })
export class LoginLogout extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.draw(ev.action, ev.payload.settings);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.draw(ev.action, ev.payload.settings);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const mode = ev.payload.settings.mode ?? "login";
    if (mode === "logout") {
      openTerminalWithCommand("claude auth logout");
      return;
    }
    // login and add-account both spawn `claude auth login` and then poll
    // the keychain for the resulting credentials, adopting them into the
    // registry once they change. The displayName is only used when the
    // resulting account is new.
    const displayName = (ev.payload.settings.displayName ?? "").trim() || undefined;
    openTerminalWithCommand("claude auth login");
    accountsService.pollForNewLogin(displayName);
  }

  private async draw(keyAction: KeyAction<Settings>, settings: Settings): Promise<void> {
    const { svg } = drawLoginLogout({ mode: settings.mode });
    await keyAction.setImage(await toImageUri(svg));
  }
}
