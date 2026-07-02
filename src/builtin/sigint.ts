export const CTRL_C_CONFIRM_WINDOW_MS = 2000;

export type CtrlCAction =
  | "arm-interrupt"
  | "interrupt"
  | "arm-exit"
  | "exit";

type PendingCtrlCAction = "interrupt" | "exit";

export interface CtrlCStateOptions {
  windowMs?: number;
  now?: () => number;
}

export interface CtrlCState {
  press(isGenerating: boolean): CtrlCAction;
  reset(): void;
}

export function createCtrlCState(options: CtrlCStateOptions = {}): CtrlCState {
  const windowMs = options.windowMs ?? CTRL_C_CONFIRM_WINDOW_MS;
  const now = options.now ?? Date.now;

  let pending: PendingCtrlCAction | null = null;
  let lastPressAt = 0;

  return {
    press(isGenerating: boolean): CtrlCAction {
      const action: PendingCtrlCAction = isGenerating ? "interrupt" : "exit";
      const current = now();
      const isConfirmed = pending === action && current - lastPressAt <= windowMs;

      if (isConfirmed) {
        pending = null;
        lastPressAt = 0;
        return action;
      }

      pending = action;
      lastPressAt = current;
      return isGenerating ? "arm-interrupt" : "arm-exit";
    },

    reset(): void {
      pending = null;
      lastPressAt = 0;
    },
  };
}
