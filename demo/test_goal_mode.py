"""
demo/test_goal_mode.py — 测试三种 CLI 是否支持 /goal 指令

对每个 CLI 发送 /goal 前缀的消息，观察:
  1. CLI 是否将 /goal 识别为特殊指令（如设置会话目标）
  2. CLI 是否将 /goal 当作普通文本处理
  3. CLI 的回复中是否提及 goal/task/目标 等概念

用法:
  python demo/test_goal_mode.py              # 测试全部
  python demo/test_goal_mode.py --claude     # 仅测试 Claude
  python demo/test_goal_mode.py --cursor     # 仅测试 Cursor
  python demo/test_goal_mode.py --codex      # 仅测试 Codex
"""

import subprocess
import sys
import os
import json
import argparse

# ---------------------------------------------------------------------------
# 颜色 (ANSI)
# ---------------------------------------------------------------------------
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
DIM = "\033[2m"
RESET = "\033[0m"
BOLD = "\033[1m"

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _run(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    kwargs.setdefault("encoding", "utf-8")
    kwargs.setdefault("errors", "replace")
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    return subprocess.run(args, **kwargs)


def cwd() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def find_claude_binary() -> str:
    sdk_dir = os.path.join(cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk")
    if os.path.isdir(sdk_dir):
        manifest_path = os.path.join(sdk_dir, "manifest.json")
        if os.path.exists(manifest_path):
            with open(manifest_path) as f:
                manifest = json.load(f)
            platforms = manifest.get("platforms", {})
            triple = f"{sys.platform}-x64"
            pkg_name = f"claude-agent-sdk-{triple}"
            pkg_dir = os.path.join(sdk_dir, "..", pkg_name)
            if os.path.isdir(pkg_dir):
                bin_name = platforms.get(triple, {}).get("binary", "claude.exe" if sys.platform == "win32" else "claude")
                bin_path = os.path.join(pkg_dir, bin_name)
                if os.path.isfile(bin_path):
                    return bin_path
    return "claude.exe" if sys.platform == "win32" else "claude"


def find_cursor_agent() -> str:
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        if local_app_data:
            p = os.path.join(local_app_data, "cursor-agent", "agent.cmd")
            if os.path.isfile(p):
                return p
        return "agent.cmd"
    return "agent"


def find_codex_binary() -> str:
    return "codex"


# ---------------------------------------------------------------------------
# 结果分析
# ---------------------------------------------------------------------------

def analyze_response(text_output: str, tool_uses: list[str]) -> dict:
    """
    分析 CLI 回复，判断对 /goal 的处理方式。
    返回: { "recognized": bool, "behavior": str, "evidence": str }
    """
    text_lower = text_output.lower()

    # CLI 明确表示 /goal 是已知指令（即使当前环境不可用也算识别）
    native_goal_recognition = [
        "/goal isn't available", "goal is not available",
        "/goal command", "goal command",
    ]
    # CLI 明确表示不认识
    not_understood = [
        "not a command", "unknown command", "unrecognized", "不支持",
        "不是有效指令", "not recognized", "not a valid command", "don't understand",
    ]

    has_native_recognition = any(kw in text_lower for kw in native_goal_recognition)
    has_not_understood = any(kw in text_lower for kw in not_understood)

    if has_native_recognition:
        return {
            "recognized": True,
            "behavior": "CLI 原生支持 /goal 指令（当前环境可能未启用）",
            "evidence": text_output.strip()[:200],
        }
    elif has_not_understood:
        return {
            "recognized": False,
            "behavior": "CLI 明确表示不认识 /goal 指令",
            "evidence": text_output.strip()[:200],
        }
    elif text_output.strip():
        return {
            "recognized": False,
            "behavior": "CLI 将 /goal 当作普通消息前缀处理（无特殊识别）",
            "evidence": text_output.strip()[:200],
        }
    else:
        return {
            "recognized": False,
            "behavior": "CLI 无文本回复",
            "evidence": f"工具调用: {tool_uses}" if tool_uses else "(空)",
        }


# ---------------------------------------------------------------------------
# Claude 测试
# ---------------------------------------------------------------------------

def test_claude_goal():
    """测试 Claude CLI 对 /goal 指令的响应"""
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Claude Code — /goal 指令测试{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")

    binary = find_claude_binary()
    project_dir = cwd()
    print(f"{DIM}  Binary : {binary}{RESET}")
    print(f"{DIM}  CWD    : {project_dir}{RESET}")

    # Step 1: 创建 session
    print(f"\n{YELLOW}[1/2] 创建 session ...{RESET}")
    args = [
        binary, "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
        "--dangerously-skip-permissions",
        "--settings", '{"maxTurns":0}',
        "ok",
    ]
    proc = _run(args, cwd=project_dir, timeout=60)
    session_id = None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if msg.get("session_id"):
                session_id = msg["session_id"]
                break
        except json.JSONDecodeError:
            pass

    if not session_id:
        print(f"{RED}  FAIL: 未能获取 session_id{RESET}")
        return
    print(f"{GREEN}  Session: {session_id}{RESET}")

    # Step 2: 发送 /goal 指令
    goal_prompt = "/goal 请帮我为一个用户登录系统设计数据库表结构，并告诉我你打算怎么做。注意：只分析规划，不要写代码。"

    print(f"\n{YELLOW}[2/2] 发送 /goal 指令 ...{RESET}")
    print(f"  {DIM}Prompt: {goal_prompt[:80]}...{RESET}")

    args = [
        binary, "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
        "--dangerously-skip-permissions",
        "--resume", session_id,
        "--input-format", "stream-json",
        "--replay-user-messages",
    ]
    stdin_line = json.dumps({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": goal_prompt}],
        },
    }) + "\n"

    try:
        proc = _run(args, cwd=project_dir, input=stdin_line, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  {RED}TIMEOUT{RESET}")
        return

    text_output = ""
    tool_uses = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "assistant" and msg.get("message", {}).get("content"):
            for block in msg["message"]["content"]:
                if block.get("type") == "text" and block.get("text"):
                    text_output += block["text"]
                elif block.get("type") == "tool_use":
                    tool_uses.append(block.get("name", "unknown"))

    result = analyze_response(text_output, tool_uses)
    _print_result("Claude", result)


# ---------------------------------------------------------------------------
# Cursor 测试
# ---------------------------------------------------------------------------

def test_cursor_goal():
    """测试 Cursor Agent 对 /goal 指令的响应"""
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Cursor Agent — /goal 指令测试{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")

    binary = find_cursor_agent()
    project_dir = cwd()
    print(f"{DIM}  Binary : {binary}{RESET}")
    print(f"{DIM}  CWD    : {project_dir}{RESET}")

    # Step 1: 创建 session
    print(f"\n{YELLOW}[1/2] 创建 session ...{RESET}")
    args = [binary, "-p", "--output-format", "stream-json", "ok"]
    proc = _run(args, cwd=project_dir, timeout=60)

    session_id = None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "system" and msg.get("subtype") == "init" and msg.get("session_id"):
            session_id = msg["session_id"]
            break

    if not session_id:
        print(f"  {RED}FAIL: 未能获取 session_id{RESET}")
        print(f"  stderr: {(proc.stderr or '')[:300]}")
        return
    print(f"{GREEN}  Session: {session_id}{RESET}")

    # Step 2: 发送 /goal 指令
    goal_prompt = "/goal 请帮我为一个用户登录系统设计数据库表结构，并告诉我你打算怎么做。注意：只分析规划，不要写代码。"

    print(f"\n{YELLOW}[2/2] 发送 /goal 指令 ...{RESET}")
    print(f"  {DIM}Prompt: {goal_prompt[:80]}...{RESET}")

    args = [binary, "-p", "--output-format", "stream-json", "--resume", session_id]
    try:
        proc = _run(args, cwd=project_dir, input=goal_prompt, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  {RED}TIMEOUT{RESET}")
        return

    text_output = ""
    tool_uses = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "assistant" and msg.get("message", {}).get("content"):
            for block in msg["message"]["content"]:
                if block.get("type") == "text" and block.get("text"):
                    text_output += block["text"]
                elif block.get("type") == "tool_use":
                    tool_uses.append(block.get("name", "unknown"))
        if msg.get("type") == "result" and msg.get("result"):
            text_output += msg["result"]

    result = analyze_response(text_output, tool_uses)
    _print_result("Cursor", result)


# ---------------------------------------------------------------------------
# Codex 测试
# ---------------------------------------------------------------------------

def test_codex_goal():
    """测试 Codex CLI 对 /goal 指令的响应"""
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Codex CLI — /goal 指令测试{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")

    binary = find_codex_binary()
    project_dir = cwd()
    print(f"{DIM}  Binary : {binary}{RESET}")
    print(f"{DIM}  CWD    : {project_dir}{RESET}")

    goal_prompt = "/goal 请帮我为一个用户登录系统设计数据库表结构，并告诉我你打算怎么做。注意：只分析规划，不要写代码。"

    print(f"\n{YELLOW}[1/1] 发送 /goal 指令 ...{RESET}")
    print(f"  {DIM}Prompt: {goal_prompt[:80]}...{RESET}")

    base_args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]
    args = [binary] + base_args + ["-C", project_dir, "-"]

    try:
        proc = _run(args, cwd=project_dir, input=goal_prompt, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  {RED}TIMEOUT{RESET}")
        return
    except FileNotFoundError:
        print(f"  {RED}Codex 未安装或不在 PATH 中{RESET}")
        return

    text_output = ""
    commands = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "item.completed" and msg.get("item", {}).get("type") == "agent_message":
            text_output += (msg["item"].get("text") or "")
        if msg.get("type") == "item.started" and msg.get("item", {}).get("type") == "command_execution":
            commands.append(msg["item"].get("command", ""))

    result = analyze_response(text_output, commands)
    _print_result("Codex", result)


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def _print_result(name: str, result: dict):
    print(f"\n  {BOLD}结果分析:{RESET}")
    status = GREEN if result["recognized"] else YELLOW
    print(f"  {status}识别 /goal: {'是' if result['recognized'] else '否'}{RESET}")
    print(f"  {DIM}行为: {result['behavior']}{RESET}")
    if result["evidence"]:
        evidence = result["evidence"].replace("\n", "\\n")
        print(f"  {DIM}证据: {evidence}{RESET}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="测试三种 CLI 对 /goal 指令的支持")
    parser.add_argument("--claude", action="store_true")
    parser.add_argument("--cursor", action="store_true")
    parser.add_argument("--codex", action="store_true")
    args = parser.parse_args()

    run_all = not (args.claude or args.cursor or args.codex)

    print(f"{BOLD}测试三种 CLI 的 /goal 指令支持{RESET}")
    print(f"{DIM}观察各 CLI 是否将 /goal 识别为特殊指令还是当作普通文本{RESET}")

    if run_all or args.claude:
        test_claude_goal()

    if run_all or args.cursor:
        test_cursor_goal()

    if run_all or args.codex:
        test_codex_goal()

    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  说明{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")
    print(f"  /goal 是一个约定俗成的提示词前缀，用于向 Agent 传达高层目标。")
    print(f"  它不是 CLI 原生命令，而是提示词工程的一部分。")
    print(f"  关键在于 CLI 是否会将其理解为「设定目标」而非「一个字面指令」。")
    print()


if __name__ == "__main__":
    main()