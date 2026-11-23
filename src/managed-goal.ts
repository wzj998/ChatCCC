import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ManagedGoalTool = "cursor" | "ccc" | "dsh";
export type ManagedGoalStatus = "active" | "paused" | "blocked" | "complete" | "cleared";
type Goal = { objective: string; status: ManagedGoalStatus; rounds: number; reason?: string };
type RunTurn = (prompt: string) => Promise<{ outcome: string; reply: string }>;
const ROUND_LIMIT = 8;

export function isManagedGoalTool(tool: string): tool is ManagedGoalTool {
  return tool === "cursor" || tool === "ccc" || tool === "dsh";
}

export function createManagedGoalRunner(directory: string) {
  const running = new Set<string>();
  const file = (id: string, tool: ManagedGoalTool) => join(directory,
    createHash("sha256").update(tool + "\0" + id).digest("hex") + ".json");

  const readRecord = (path: string): Goal | null => {
    try { return JSON.parse(readFileSync(path, "utf8")) as Goal; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const write = (path: string, goal: Goal) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(goal), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    return goal;
  };
  const read = (id: string, tool: ManagedGoalTool): Goal | null => {
    const path = file(id, tool);
    const goal = readRecord(path);
    if (goal?.status === "active" && !running.has(path)) {
      return { ...goal, status: "paused", reason: "服务重启后等待手动恢复" };
    }
    return goal;
  };
  const pause = (id: string, tool: ManagedGoalTool) => {
    const path = file(id, tool);
    const goal = readRecord(path);
    return goal?.status === "active" ? write(path, { ...goal, status: "paused" }) : goal;
  };
  const clear = (id: string, tool: ManagedGoalTool) => rmSync(file(id, tool), { force: true });

  async function start(id: string, tool: ManagedGoalTool, objective: string | undefined, turn: RunTurn): Promise<Goal> {
    const path = file(id, tool);
    if (running.has(path)) throw new Error("目标已有执行轮次，请暂停后等待当前轮结束");
    const previous = read(id, tool);
    if (objective === undefined && (!previous || previous.status === "complete")) {
      throw new Error("没有可恢复的目标");
    }
    let goal: Goal = {
      objective: objective ?? previous!.objective,
      status: "active",
      rounds: objective === undefined ? previous!.rounds : 0,
    };
    if (!goal.objective.trim() || Array.from(goal.objective).length > 4_000) {
      throw new Error("目标需要 1 至 4000 个字符");
    }
    const stop = (status: ManagedGoalStatus, reason?: string) => write(path, { ...goal, status, reason });
    running.add(path);
    try {
      write(path, goal);
      let previousReply = "";
      for (let i = 0; i < ROUND_LIMIT; i++) {
        let result: Awaited<ReturnType<RunTurn>>;
        try {
          result = await turn([
            "继续处理当前目标。根据上一轮的实际产物继续，先核对仍在执行的操作，避免重复执行。",
            "遇到权限、缺失输入或需要用户决定时，说明原因并停止。只有验收证据齐全才声明完成。",
            "在回复最后一行单独输出 [[GOAL:continue]]（有具体进展且仍需推进）、[[GOAL:complete]]（已验收）或 [[GOAL:blocked]]（需要解决阻碍）。",
            "目标：" + JSON.stringify(goal.objective),
          ].join("\n"));
        } catch {
          result = { outcome: "error", reply: "" };
        }
        const current = readRecord(path);
        if (!current) return { ...goal, status: "cleared" };
        if (current.status !== "active") return current;
        goal = { ...goal, rounds: goal.rounds + 1 };
        if (result.outcome === "stopped") return stop("paused");
        if (result.outcome !== "done") return stop("blocked", "执行回合结束状态：" + result.outcome);
        const reply = result.reply.trim();
        const marker = /(?:^|\n)\[\[GOAL:(continue|complete|blocked)\]\]$/.exec(reply);
        const evidence = marker ? reply.slice(0, marker.index).trim() : "";
        if (!marker || !evidence) return stop("blocked", "本轮缺少明确状态或结果");
        if (marker[1] === "complete") return stop("complete");
        if (marker[1] === "blocked") return stop("blocked", "请查看最后一轮的阻碍说明");
        if (evidence === previousReply) return stop("blocked", "连续两轮返回相同结果");
        previousReply = evidence;
        write(path, goal);
      }
      return stop("paused", "达到本次自动续跑上限，可用 /goal resume 继续");
    } finally {
      running.delete(path);
    }
  }
  return { read, pause, clear, start, isRunning: (id: string, tool: ManagedGoalTool) => running.has(file(id, tool)) };
}
