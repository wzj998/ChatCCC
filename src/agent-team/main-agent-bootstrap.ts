import type { PlatformAdapter } from "../platform-adapter.ts";
import { MainAgentService } from "./application/main-agent-service.ts";
import { TaskExecutionService } from "./application/task-execution-service.ts";
import {
  defaultAgentTeamBoardService,
  setDefaultAgentTeamMainAgentService,
  setDefaultAgentTeamTaskExecutionService,
} from "./http/board-routes.ts";
import { createMainAgentSessionRuntime } from "./infrastructure/main-agent-session-runtime.ts";
import { createTaskExecutionRuntime } from "./infrastructure/task-execution-runtime.ts";
import { feishuP2pContactStore } from "./repositories/feishu-p2p-contact-store.ts";
import { JsonMainAgentBindingRepository } from "./repositories/main-agent-binding-repository.ts";
import { JsonTaskRunRepository } from "./repositories/json-task-run-repository.ts";

/** Wire runtime dependencies only from index.ts, keeping the standalone Web UI import side-effect free. */
export function configureAgentTeamMainAgent(platform: PlatformAdapter): void {
  const bindingRepository = new JsonMainAgentBindingRepository();
  const mainAgentService = new MainAgentService({
    boardService: defaultAgentTeamBoardService,
    bindingRepository,
    contactStore: feishuP2pContactStore,
    platform,
    runtime: createMainAgentSessionRuntime(platform),
  });
  const taskExecutionService = new TaskExecutionService({
    boardService: defaultAgentTeamBoardService,
    repository: new JsonTaskRunRepository(),
    runtime: createTaskExecutionRuntime(platform),
    getBinding: (projectId) => bindingRepository.get(projectId),
  });
  setDefaultAgentTeamMainAgentService(mainAgentService);
  setDefaultAgentTeamTaskExecutionService(taskExecutionService);
  void taskExecutionService.recoverInterruptedRuns().catch((err) => {
    console.error(`[Agent Team] Failed to recover interrupted task runs: ${(err as Error).message}`);
  });
}
