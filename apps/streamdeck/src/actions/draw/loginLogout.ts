import { renderValueKey } from "../../render/svg.js";

export type LoginLogoutMode = "login" | "logout";

const TEXT: Record<LoginLogoutMode, { value: string; label: string }> = {
  login: { value: "log in", label: "claude auth" },
  logout: { value: "log out", label: "claude auth" },
};

export function drawLoginLogout({ mode }: { mode?: LoginLogoutMode }): { svg: string } {
  const m: LoginLogoutMode = mode ?? "login";
  const { value, label } = TEXT[m];
  return { svg: renderValueKey({ value, label }) };
}
