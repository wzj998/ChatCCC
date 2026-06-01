"""
demo/test_ask_mode.py — 测试三种 CLI 的 Ask Mode（只读模式）

对每个 CLI 发送"读取类"和"写入类"两个 prompt:
  - Read prompt:  读取 package.json 报告项目名 — ask mode 下应成功
  - Write prompt: 创建文件 — ask mode 下应被拒绝/仅规划、不实际写盘

用法:
  python demo/test_ask_mode.py              # 测试全部三个 CLI
  python demo/test_ask_mode.py --claude     # 仅测试 Claude
  python demo/test_ask_mode.py --cursor     # 仅测试 Cursor
  python demo/test_ask_mode.py --codex      # 仅测试 Codex
"""

import subprocess
import sys
import os
import json
import time
import argparse
from pathlib import Path

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


def color(status: str, text: str) -> str:
    return f"{status}{text}{RESET}"


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

# Windows 下 subprocess 默认用 GBK 解码，但 CLI 工具输出 UTF-8。
# 封装统一的 run 调用。
def _run(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    kwargs.setdefault("encoding", "utf-8")
    kwargs.setdefault("errors", "replace")
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    return subprocess.run(args, **kwargs)

def find_claude_binary() -> str:
    """查找 claude.exe 路径 (优先从 node_modules 解析 manifest.json)"""
    import glob as _glob

    # 尝试从 node_modules 中找
    sdk_dir = os.path.join(
        os.path.dirname(__file__), "..", "node_modules",
        "@anthropic-ai", "claude-agent-sdk"
    )
    if os.path.isdir(sdk_dir):
        manifest_path = os.path.join(sdk_dir, "manifest.json")
        if os.path.exists(manifest_path):
            with open(manifest_path) as f:
                manifest = json.load(f)
            platforms = manifest.get("platforms", {})
            triple = f"{sys.platform}-{_arch()}"
            for candidate in [triple]:
                if sys.platform == "linux":
                    candidate = f"{sys.platform}-{_arch()}-musl"
                pkg_name = f"claude-agent-sdk-{candidate}"
                pkg_dir = os.path.join(sdk_dir, "..", pkg_name)
                if not os.path.isdir(pkg_dir):
                    # try non-musl
                    candidate = triple
                    pkg_dir = os.path.join(sdk_dir, "..", f"claude-agent-sdk-{candidate}")
                if os.path.isdir(pkg_dir):
                    bin_name = platforms.get(candidate, {}).get("binary", "claude.exe" if sys.platform == "win32" else "claude")
                    bin_path = os.path.join(pkg_dir, bin_name)
                    if os.path.isfile(bin_path):
                        return bin_path

    # fallback
    return "claude.exe" if sys.platform == "win32" else "claude"


def _arch() -> str:
    m = os.uname().machine if hasattr(os, "uname") else "x64"
    if m in ("x86_64", "AMD64", "x64"):
        return "x64"
    if m in ("arm64", "aarch64"):
        return "arm64"
    return m


def find_cursor_agent() -> str:
    """查找 Cursor agent 可执行文件"""
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


def run_cli(cmd: list[str], cwd: str, stdin_text: str | None = None,
            timeout: int = 60) -> tuple[int, str, str]:
    """运行 CLI 并返回 (exit_code, stdout, stderr)"""
    try:
        proc = _run(cmd, cwd=cwd, input=stdin_text, timeout=timeout)
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"TIMEOUT after {timeout}s"
    except FileNotFoundError as e:
        return -2, "", str(e)


def cwd() -> str:
    """项目根目录作为测试工作目录"""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# Claude Ask Mode 测试
# ---------------------------------------------------------------------------

def test_claude_ask_mode():
    """测试 Claude CLI --permission-mode plan (只读模式)"""
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Claude Code — Ask Mode ({CYAN}--permission-mode plan{RESET}{BOLD}){RESET}")
    print(f"{BOLD}{'='*60}{RESET}")

    binary = find_claude_binary()
    project_dir = cwd()
    print(f"{DIM}  Binary : {binary}{RESET}")
    print(f"{DIM}  CWD    : {project_dir}{RESET}")

    # 先创建 session
    print(f"\n{YELLOW}[1/3] 创建 session ...{RESET}")
    args = [
        binary, "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "plan",
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
        print(f"  stderr: {(proc.stderr or '')[:500]}")
        return False

    print(f"{GREEN}  Session: {session_id}{RESET}")

    # Test 1: 读取类 prompt
    print(f"\n{YELLOW}[2/3] 测试读取: '读取 package.json，告诉我项目名称' ...{RESET}")
    ok_read = _test_claude_prompt(binary, project_dir, session_id,
                                   "读取 package.json 文件，告诉我这个项目的 name 字段是什么。只读取，不要修改任何文件。")

    # Test 2: 写入类 prompt
    print(f"\n{YELLOW}[3/3] 测试写入: '创建 test_ask_mode.txt 内容 hello' ...{RESET}")
    ok_write = _test_claude_prompt(binary, project_dir, session_id,
                                    "请创建一个文件 test_ask_mode_claude.txt，内容是 'hello from claude ask mode test'。",
                                    expect_edit_blocked=True)

    # 清理
    test_file = os.path.join(project_dir, "test_ask_mode_claude.txt")
    if os.path.exists(test_file):
        os.remove(test_file)
        print(f"  {YELLOW}(已清理测试文件){RESET}")

    return ok_read and ok_write


def _test_claude_prompt(binary: str, project_dir: str, session_id: str,
                         prompt: str, expect_edit_blocked: bool = False) -> bool:
    args = [
        binary, "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "plan",
        "--resume", session_id,
        "--input-format", "stream-json",
        "--replay-user-messages",
    ]

    stdin_line = json.dumps({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": prompt}],
        },
    }) + "\n"

    try:
        proc = _run(args, cwd=project_dir, input=stdin_line, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  {RED}TIMEOUT{RESET}")
        return False

    text_output = ""
    tool_uses = []
    tool_results = []

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
                    tool_uses.append(block)

        if msg.get("type") == "user" and msg.get("message", {}).get("content"):
            for block in msg["message"]["content"]:
                if block.get("type") == "tool_result":
                    tool_results.append(block)

    has_write_tool = any(
        tu.get("name") in ("Write", "Edit", "write_to_file", "replace_in_file", "NotebookEdit")
        for tu in tool_uses
    )
    has_write_result = any(
        tr.get("content") and not tr.get("is_error")
        for tr in tool_results
    )

    # 打印摘要
    print(f"  {DIM}工具调用: {[tu.get('name') for tu in tool_uses]}{RESET}")
    if text_output:
        preview = text_output.strip()[:200].replace("\n", "\\n")
        print(f"  {DIM}文本输出: {preview}{'...' if len(text_output.strip()) > 200 else ''}{RESET}")

    if expect_edit_blocked:
        if has_write_tool and has_write_result:
            # plan 模式允许输出方案但不实际写入，tool_result 如果有 is_error 说明被拦截
            write_results_ok = all(
                tr.get("is_error") for tr in tool_results
                if tr.get("tool_use_id") in [tu.get("id") for tu in tool_uses if tu.get("name") in ("Write", "Edit")]  # noqa: E501
            )
            if not write_results_ok and has_write_result:
                print(f"  {RED}FAIL: ask mode 下居然执行了写入操作!{RESET}")
                return False
            else:
                print(f"  {GREEN}PASS: 写入被拦截或仅规划，符合预期{RESET}")
                return True
        elif has_write_tool and not has_write_result:
            print(f"  {GREEN}PASS: 有写入工具调用但无实际执行结果，符合预期{RESET}")
            return True
        else:
            # 没有 Write/Edit 工具调用 — plan 模式可能直接拒绝或只分析不操作
            print(f"  {GREEN}PASS: 未发起写入工具调用，符合 ask mode 预期{RESET}")
            return True
    else:
        if text_output:
            print(f"  {GREEN}PASS: 获得了文本回复{RESET}")
            return True
        else:
            print(f"  {RED}FAIL: 未获得文本回复{RESET}")
            return False


# ---------------------------------------------------------------------------
# Cursor Ask Mode 测试
# ---------------------------------------------------------------------------

def test_cursor_ask_mode():
    """测试 Cursor Agent --mode ask"""
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Cursor Agent — Ask Mode ({CYAN}--mode ask{RESET}{BOLD}){RESET}")
    print(f"{BOLD}{'='*60}{RESET}")

    binary = find_cursor_agent()
    project_dir = cwd()
    print(f"{DIM}  Binary : {binary}{RESET}")
    print(f"{DIM}  CWD    : {project_dir}{RESET}")

    # 创建 session（用 ask mode）
    print(f"\n{YELLOW}[1/3] 创建 session (--mode ask) ...{RESET}")
    args = [binary, "-p", "--mode", "ask", "--output-format", "stream-json", "ok"]
    try:
        proc = _run(args, cwd=project_dir, timeout=60)
    except subprocess.TimeoutExpired:
        print(f"  {RED}TIMEOUT{RESET}")
        return False

    if proc.returncode != 0 and proc.returncode != 1:
        # Cursor 有时 exit 1 但正常返回 session_id
        pass

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
        # 检查是不是 --mode ask 不支持
        stderr_lower = (proc.stderr or "").lower()
        if "unknown option" in stderr_lower or "unrecognized" in stderr_lower or "invalid" in stderr_lower:
            print(f"  {RED}FAIL: Cursor Agent 不支持 --mode ask 参数{RESET}")
            print(f"  stderr: {(proc.stderr or '')[:500]}")
            return False
        print(f"  {RED}FAIL: 未能获取 session_id{RESET}")
        print(f"  stdout: {proc.stdout[:500]}")
        print(f"  stderr: {(proc.stderr or '')[:500]}")
        return False

    print(f"{GREEN}  Session: {session_id}{RESET}")

    # Test 1: 读取
    print(f"\n{YELLOW}[2/3] 测试读取: '读取 package.json，告诉我项目名称' ...{RESET}")
    ok_read = _test_cursor_prompt(binary, project_dir, session_id,
                                   "读取 package.json 文件，告诉我这个项目的 name 字段是什么。只读取，不要修改任何文件。")

    # Test 2: 写入
    print(f"\n{YELLOW}[3/3] 测试写入: '创建 test_ask_mode_cursor.txt 内容 hello' ...{RESET}")
    ok_write = _test_cursor_prompt(binary, project_dir, session_id,
                                    "请创建一个文件 test_ask_mode_cursor.txt，内容是 'hello from cursor ask mode test'。",
                                    expect_edit_blocked=True)

    # 清理
    test_file = os.path.join(project_dir, "test_ask_mode_cursor.txt")
    if os.path.exists(test_file):
        os.remove(test_file)
        print(f"  {YELLOW}(已清理测试文件){RESET}")

    return ok_read and ok_write


def _test_cursor_prompt(binary: str, project_dir: str, session_id: str,
                         prompt: str, expect_edit_blocked: bool = False) -> bool:
    args = [binary, "-p", "--mode", "ask", "--output-format", "stream-json",
            "--resume", session_id]

    try:
        proc = _run(args, cwd=project_dir, input=prompt, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  {RED}TIMEOUT{RESET}")
        return False

    text_output = ""
    tool_uses = []
    tool_completed = []

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
                    tool_uses.append(block)

        if msg.get("type") == "tool_call" and msg.get("subtype") == "completed":
            tool_completed.append(msg)

        if msg.get("type") == "result" and msg.get("result"):
            text_output += msg["result"]

    has_write_tool = any(
        tu.get("name") in ("Write", "Edit", "write", "edit_file")
        for tu in tool_uses
    )
    has_write_executed = any(
        tc.get("tool_call", {}) and
        any(k in ("writeToolCall", "editToolCall") for k in tc["tool_call"])
        for tc in tool_completed
    )

    print(f"  {DIM}工具调用: {[tu.get('name') for tu in tool_uses]}{RESET}")
    if text_output:
        preview = text_output.strip()[:200].replace("\n", "\\n")
        print(f"  {DIM}文本输出: {preview}{'...' if len(text_output.strip()) > 200 else ''}{RESET}")

    if expect_edit_blocked:
        if has_write_executed:
            print(f"  {RED}FAIL: ask mode 下执行了写入操作!{RESET}")
            return False
        elif has_write_tool:
            print(f"  {YELLOW}WARN: 有写入工具请求但未完成执行 (可能是 ask mode 拦截){RESET}")
            return True
        else:
            print(f"  {GREEN}PASS: 未发起写入操作，符合 ask mode 预期{RESET}")
            return True
    else:
        if text_output:
            print(f"  {GREEN}PASS: 获得了文本回复{RESET}")
            return True
        else:
            print(f"  {RED}FAIL: 未获得文本回复{RESET}")
            return False


# ---------------------------------------------------------------------------
# Codex Ask Mode 测试
# ---------------------------------------------------------------------------

def test_codex_ask_mode():
    """测试 Codex CLI 是否有只读模式

    Codex CLI 没有原生的 'ask mode' 标志。
    这里尝试两种方案:
      A) 去掉 --dangerously-bypass-approvals-and-sandbox (需要用户审批)
      B) 加上 --permission-mode read (如果支持)
    """
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Codex CLI — Ask Mode 探索{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")

    binary = find_codex_binary()
    project_dir = cwd()
    print(f"{DIM}  Binary : {binary}{RESET}")
    print(f"{DIM}  CWD    : {project_dir}{RESET}")
    print(f"\n{YELLOW}  注意: Codex CLI 没有原生 'ask mode' 标志。{RESET}")
    print(f"{YELLOW}  本测试探索两种近似方案。{RESET}")

    # 方案 A: 不带 bypass，看是否会请求确认
    print(f"\n{BOLD}  方案 A: 去除 --dangerously-bypass-approvals-and-sandbox{RESET}")
    _test_codex_approach(project_dir, binary,
                          base_args=["exec", "--json", "--skip-git-repo-check"],
                          label="A (需审批)")

    # 方案 B: 尝试 --permission-mode read
    print(f"\n{BOLD}  方案 B: 尝试 --permission-mode read{RESET}")
    _test_codex_approach(project_dir, binary,
                          base_args=["exec", "--json", "--skip-git-repo-check", "--permission-mode", "read"],
                          label="B (--permission-mode read)")

    # 方案 C: 尝试 --approval-mode
    print(f"\n{BOLD}  方案 C: 尝试 --approval-mode default{RESET}")
    _test_codex_approach(project_dir, binary,
                          base_args=["exec", "--json", "--skip-git-repo-check", "--approval-mode", "default"],
                          label="C (--approval-mode default)")

    print(f"\n{YELLOW}  结论: Codex 的 ask mode 需要查看其 CLI 文档或等官方支持。{RESET}")
    print(f"{YELLOW}  当前最接近的方案是通过审批模式限制每次工具调用。{RESET}")
    return None  # 不判定 pass/fail


def _test_codex_approach(project_dir: str, binary: str, base_args: list[str], label: str):
    """测试 Codex 的某种参数组合"""
    args = [binary] + base_args + ["-C", project_dir, "-"]
    prompt = "读取 package.json 文件，告诉我这个项目的 name 字段是什么。只读取，不要修改任何文件。"

    try:
        proc = _run(args, cwd=project_dir, input=prompt, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  {RED}[{label}] TIMEOUT{RESET}")
        return
    except FileNotFoundError:
        print(f"  {RED}[{label}] codex 未安装或不在 PATH 中{RESET}")
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

    print(f"  {DIM}[{label}] 执行命令: {commands}{RESET}")
    if text_output:
        preview = text_output.strip()[:200].replace("\n", "\\n")
        print(f"  {DIM}[{label}] 文本输出: {preview}{'...' if len(text_output.strip()) > 200 else ''}{RESET}")
        print(f"  {GREEN}[{label}] 获得回复{RESET}")
    else:
        print(f"  {RED}[{label}] 无文本回复{RESET}")
        if proc.stderr:
            print(f"  {DIM}[{label}] stderr: {(proc.stderr or '')[:300]}{RESET}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="测试三种 CLI 的 Ask Mode")
    parser.add_argument("--claude", action="store_true", help="仅测试 Claude")
    parser.add_argument("--cursor", action="store_true", help="仅测试 Cursor")
    parser.add_argument("--codex", action="store_true", help="仅测试 Codex")
    args = parser.parse_args()

    run_all = not (args.claude or args.cursor or args.codex)

    results = {}

    if run_all or args.claude:
        results["Claude"] = test_claude_ask_mode()

    if run_all or args.cursor:
        results["Cursor"] = test_cursor_ask_mode()

    if run_all or args.codex:
        results["Codex"] = test_codex_ask_mode()

    # 汇总
    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  测试结果汇总{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")
    for name, ok in results.items():
        if ok is True:
            print(f"  {GREEN}PASS{RESET}  {name}")
        elif ok is False:
            print(f"  {RED}FAIL{RESET}  {name}")
        else:
            print(f"  {YELLOW}N/A{RESET}   {name} (需人工判断)")

    all_pass = all(v is not False for v in results.values())
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    main()