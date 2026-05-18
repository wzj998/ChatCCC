// postinstall 检测 sharp 原生模块是否可用（常见于 Linux 缺少 libvips）
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ok = false;

try {
  require("sharp");
  ok = true;
} catch (err) {
  const msg = err.message;
  const platform = process.platform;

  console.warn("");
  console.warn("============================================================");
  console.warn("  ChatCCC: sharp 图像处理模块检测失败");
  console.warn("============================================================");

  if (platform === "linux") {
    if (msg.includes("libvips") || msg.includes("vips") || msg.includes("libglib")) {
      console.warn("  原因：系统缺少 libvips 图像处理库。");
      console.warn("");
      console.warn("  请先安装 libvips 然后重建 sharp：");
      console.warn("");
      console.warn("  Debian / Ubuntu:");
      console.warn("    sudo apt install libvips-dev");
      console.warn("");
      console.warn("  CentOS / RHEL / Fedora:");
      console.warn("    sudo yum install vips-devel");
      console.warn("");
      console.warn("  Alpine:");
      console.warn("    sudo apk add vips-dev");
      console.warn("");
      console.warn("  安装 libvips 后重建 sharp：");
      console.warn("    npm install -g chatccc --force");
    } else if (msg.includes("Cannot find module")) {
      console.warn("  原因：sharp 模块未成功安装。");
      console.warn("");
      console.warn("  请尝试重建（可能需要先安装 libvips）：");
      console.warn("    npm install -g chatccc --force");
    } else {
      console.warn("  错误详情：", msg);
    }
  } else {
    console.warn("  错误详情：", msg);
    console.warn("  平台：", platform);
    console.warn("  请尝试：npm install -g chatccc --force");
  }

  console.warn("");
  console.warn("  缺少 sharp 不影响消息收发，但群聊头像状态指示");
  console.warn("  （运行中/空闲/新建）将不会更新。");
  console.warn("============================================================");
  console.warn("");
}

if (!ok && process.env.npm_config_verbose) {
  process.exitCode = 0; // 永远不阻塞安装
}