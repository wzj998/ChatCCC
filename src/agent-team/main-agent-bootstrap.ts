import type { PlatformAdapter } from "../platform-adapter.ts";
import { MainAgentService } from "./application/main-agent-service.ts";
import {
  defaultAgentTeamBoardService,
  setDefaultAgentTeamMainAgentService,
} from "./http/board-routes.ts";
import { createMainAgentSessionRuntime } from "./infrastructure/main-agent-session-runtime.ts";
import { feishuP2pContactStore } from "./repositories/feishu-p2p-contact-store.ts";
import { JsonMainAgentBindingRepository } from "./repositories/main-agent-binding-repository.ts";

/** Wire runtime dependencies only from index.ts, keeping the standalone Web UI import side-effect free. */
export function configureAgentTeamMainAgent(platform: PlatformAdapter): void {
  setDefaultAgentTeamMainAgentService(new MainAgentService({
    boardService: defaultAgentTeamBoardService,
    bindingRepository: new JsonMainAgentBindingRepository(),
    contactStore: feishuP2pContactStore,
    platform,
    runtime: createMainAgentSessionRuntime(platform),
  }));
}
