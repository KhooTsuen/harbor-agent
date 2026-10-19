/**
 * 自检分组清单（从 selftest.mjs 抽出来的）
 *
 * 为什么抽：`selftest.mjs` 顶到 300 行红线（硬约束 #2），而它 90% 的行是
 * 「一组一行」的 import + GROUPS 数组 —— 这部分**只增不减**（每加一个自检组
 * 就多一行），留在主文件里等于把红线焊死。抽出来之后主文件只剩「跑 + 收尾」。
 *
 * ⚠️ **加载时机不变**：本文件被 `selftest.mjs` 静态 import，各 group 模块的顶层
 * 代码仍在 `prepareSelftest()` 之前执行 —— 与原实现一字不差（`paths.cjs` 的
 * `isSelftestRun()` 判的是 `process.argv[1]`，只认 `selftest.mjs`，不受影响）。
 *
 * 加新组：在这里 import 一行、GROUPS 里加一项（组间不共享状态，见各组文件头）。
 * ★ GROUPS 的顺序 = 运行顺序，**动了就是行为变更**（别顺手重排）。
 */

import { run as basics } from './groups/01-basics.mjs'
import { run as skillsMemory } from './groups/02-skills-memory.mjs'
import { run as fsSafety } from './groups/03-fs-safety.mjs'
import { run as reliability } from './groups/04-reliability.mjs'
import { run as agentLoop } from './groups/05-agent-loop.mjs'
import { run as promptState } from './groups/06-prompt-state.mjs'
import { run as personaRoutingGroup } from './groups/142-persona-routing.mjs'
import { run as northStarGroup } from './groups/143-north-star.mjs'
import { run as strictModeGroup } from './groups/144-strict-mode.mjs'
import { run as markStepDoneGroup } from './groups/145-mark-step-done.mjs'
import { run as memorySearchGroup } from './groups/146-memory-search.mjs'
import { run as fsRootScopeGroup } from './groups/147-fs-root-scope.mjs'
import { run as promptSplitGroup } from './groups/148-prompt-split.mjs'
import { run as providerBalanceGroup } from './groups/149-provider-balance.mjs'
import { run as usageReasoningGroup } from './groups/150-usage-reasoning.mjs'
import { run as pricingGroup } from './groups/151-pricing.mjs'
import { run as browserIdentityGroup } from './groups/152-browser-identity.mjs'
import { run as userConstraintsGroup } from './groups/153-user-constraints.mjs'
import { run as nativeHostGroup } from './groups/154-native-host.mjs'
import { run as nativeHostInstallGroup } from './groups/155-native-host-install.mjs'
import { run as extBridgeGroup } from './groups/156-ext-bridge.mjs'
import { run as extProtocolGroup } from './groups/157-ext-protocol.mjs'
import { run as extChatGroup } from './groups/158-ext-chat.mjs'
import { run as extCommandGroup } from './groups/160-ext-command.mjs'
import { run as observeGroup } from './groups/159-observe.mjs'
import { run as actGroup } from './groups/161-act.mjs'
import { run as m04RestGroup } from './groups/162-m04-rest.mjs'
import { run as edgeToolsGroup } from './groups/163-edge-tools.mjs'
import { run as m02PanelGroup } from './groups/164-m02-panel.mjs'
import { run as codexAdapterGroup } from './groups/165-codex-adapter.mjs'
import { run as codexStabilityGroup } from './groups/166-codex-stability.mjs'
import { run as probeIsolationGroup } from './groups/167-probe-isolation.mjs'
import { run as projectRootsGroup } from './groups/169-project-roots.mjs'
import { run as collabGroup } from './groups/170-collab.mjs'
import { run as collabStateGroup } from './groups/171-collab-state.mjs'
import { run as downloadProgressGroup } from './groups/172-download-progress.mjs'
import { run as testFixGroup } from './groups/168-test-fix.mjs'
import { run as llmBody } from './groups/07-llm-body.mjs'
import { run as limits } from './groups/08-limits.mjs'
import { run as browser } from './groups/09-browser.mjs'
import { run as plugins } from './groups/10-plugins.mjs'
import { run as images } from './groups/11-images.mjs'
import { run as requires } from './groups/12-requires.mjs'
import { run as imagesTool } from './groups/13-images-tool.mjs'
import { run as taskContext } from './groups/14-task-context.mjs'
import { run as lifecycle } from './groups/15-lifecycle.mjs'
import { run as eventsBus } from './groups/16-events.mjs'
import { run as metrics } from './groups/17-metrics.mjs'
import { run as plan } from './groups/18-plan.mjs'
import { run as abortTrace } from './groups/19-abort.mjs'
import { run as streamBatch } from './groups/20-streambatch.mjs'
import { run as resume } from './groups/21-resume.mjs'
import { run as recovery } from './groups/22-recovery.mjs'
import { run as approval } from './groups/23-approval.mjs'
import { run as errorKinds } from './groups/24-errors.mjs'
import { run as autoRecover } from './groups/25-autorecover.mjs'
import { run as continueAfterFail } from './groups/26-continue.mjs'
import { run as continuity } from './groups/27-continuity.mjs'
import { run as fileCache } from './groups/28-filecache.mjs'
import { run as contextCache } from './groups/29-contextcache.mjs'
import { run as taskName } from './groups/30-taskname.mjs'
import { run as sessionRedact } from './groups/31-session-redact.mjs'
import { run as notify } from './groups/32-notify.mjs'
import { run as confirmNotify } from './groups/111-confirm-notify.mjs'
import { run as browseNotify } from './groups/112-browse-notify.mjs'
import { run as trayGroup } from './groups/33-tray.mjs'
import { run as taskOutcome } from './groups/34-outcome.mjs'
import { run as checkpoint } from './groups/35-checkpoint.mjs'
import { run as diagnose } from './groups/36-diagnose.mjs'
import { run as writeDiff } from './groups/37-writediff.mjs'
import { run as changesetDiff } from './groups/38-changesetdiff.mjs'
import { run as perf } from './groups/39-perf.mjs'
import { run as taskIndex } from './groups/40-taskindex.mjs'
import { run as budgetGroup } from './groups/41-budget.mjs'
import { run as loopGuard } from './groups/42-loopguard.mjs'
import { run as consoleGroup } from './groups/43-console.mjs'
import { run as steeringGroup } from './groups/44-steering.mjs'
import { run as pauseGroup } from './groups/45-pause.mjs'
import { run as acceptanceGroup } from './groups/46-acceptance.mjs'
import { run as purgeGroup } from './groups/47-purge.mjs'
import { run as profileGroup } from './groups/48-profile.mjs'
import { run as injectionGroup } from './groups/49-injection.mjs'
import { run as pathEncoding } from './groups/50-path-encoding.mjs'
import { run as mcpPresets } from './groups/51-mcp-presets.mjs'
import { run as interrupted } from './groups/52-interrupted.mjs'
import { run as partialPersist } from './groups/53-partial-persist.mjs'
import { run as versionSync } from './groups/54-version-sync.mjs'
import { run as taskReuse } from './groups/55-task-reuse.mjs'
import { run as answers } from './groups/56-answers.mjs'
import { run as logging } from './groups/57-logging.mjs'
import { run as actionLog } from './groups/58-actionlog.mjs'
import { run as selectorStability } from './groups/59-selector.mjs'
import { run as answerPick } from './groups/60-answer-pick.mjs'
import { run as destructive } from './groups/61-destructive.mjs'
import { run as redactFields } from './groups/62-redact-fields.mjs'
import { run as durableIntent } from './groups/63-durable-intent.mjs'
import { run as approvalCenter } from './groups/64-approval-center.mjs'
import { run as tokenBadge } from './groups/65-token-badge.mjs'
import { run as rollbackTo } from './groups/66-rollback-to.mjs'
import { run as artifactGroup } from './groups/67-artifact.mjs'
import { run as skillPerms } from './groups/68-skill-perms.mjs'
import { run as providerCaps } from './groups/70-provider-caps.mjs'
import { run as memoryExplain } from './groups/71-memory-explain.mjs'
import { run as scheduleGroup } from './groups/72-schedule.mjs'
import { run as netPolicyGroup } from './groups/73-net-policy.mjs'
import { run as sessionCrypto } from './groups/74-session-crypto.mjs'
import { run as projectsGroup } from './groups/75-projects.mjs'
import { run as taskPresets } from './groups/76-task-presets.mjs'
import { run as consistencyGroup } from './groups/77-consistency.mjs'
import { run as boundsGroup } from './groups/78-bounds.mjs'
import { run as llmStream } from './groups/79-llm-stream.mjs'
import { run as handlersGroup } from './groups/80-handlers.mjs'
import { run as regenGroup } from './groups/81-regen.mjs'
import { run as taskIsolationGroup } from './groups/82-task-isolation.mjs'
import { run as branchPathGroup } from './groups/83-branch-path.mjs'
import { run as launchSummaryGroup } from './groups/84-launch-summary.mjs'
import { run as tokenOptGroup } from './groups/85-token-opt.mjs'
import { run as visionGroup } from './groups/86-vision.mjs'
import { run as modelChoiceGroup } from './groups/87-model-choice.mjs'
import { run as browserWaitGroup } from './groups/88-browser-wait.mjs'
import { run as errorObserverGroup } from './groups/89-error-observer.mjs'
import { run as errorReaderGroup } from './groups/90-error-reader.mjs'
import { run as switchWiringGroup } from './groups/91-switch-wiring.mjs'
import { run as roundTranscriptGroup } from './groups/92-round-transcript.mjs'
import { run as machinePromptGroup } from './groups/93-machine-prompt.mjs'
import { run as dataDoctorGroup } from './groups/94-data-doctor.mjs'
import { run as runStatsGroup } from './groups/95-run-stats.mjs'
import { run as replayRiskGroup } from './groups/96-replay-risk.mjs'
import { run as projectRulesGroup } from './groups/97-project-rules.mjs'
import { run as rollbackPreviewGroup } from './groups/98-rollback-preview.mjs'
import { run as clarifyGroup } from './groups/99-clarify.mjs'
import { run as clarifyTimeoutGroup } from './groups/100-clarify-timeout.mjs'
import { run as confirmBridgeGroup } from './groups/101-confirm-bridge.mjs'
import { run as clarifyUnattendedGroup } from './groups/102-clarify-unattended.mjs'
import { run as clarifyWakeGroup } from './groups/103-clarify-wake.mjs'
import { run as clarifyNoticeGroup } from './groups/104-clarify-notice.mjs'
import { run as clarifyRuleGroup } from './groups/105-clarify-rule.mjs'
import { run as acceptanceVerdictGroup } from './groups/106-acceptance-verdicts.mjs'
import { run as clarifyExitsGroup } from './groups/107-clarify-exits.mjs'
import { run as scaleGateGroup } from './groups/108-scale-gate.mjs'
import { run as scaleConfigGroup } from './groups/109-scale-config.mjs'
import { run as scalePromptGroup } from './groups/110-scale-prompt.mjs'
import { run as probeGroup } from './groups/112-probe.mjs'
import { run as verifyHintGroup } from './groups/113-verify-hint.mjs'
import { run as projectFactsGroup } from './groups/114-project-facts.mjs'
import { run as memoryReflectGroup } from './groups/115-memory-reflect.mjs'
import { run as memoryConflictGroup } from './groups/133-memory-conflict-expire.mjs'
import { run as projectCompleteGroup } from './groups/116-project-context-complete.mjs'
import { run as urlPolicyGroup } from './groups/117-url-policy.mjs'
import { run as safeWriteGroup } from './groups/118-safe-write.mjs'
import { run as downloadGroup } from './groups/119-download.mjs'
import { run as editRulesGroup } from './groups/120-edit-rules.mjs'
import { run as browseNavGroup } from './groups/121-browse-nav.mjs'
import { run as modelProbeGroup } from './groups/122-model-probe.mjs'
import { run as subagentGroup } from './groups/123-subagent.mjs'
import { run as cardTimeoutGroup } from './groups/124-card-timeout.mjs'
import { run as decisionShapeGroup } from './groups/125-decision-shape.mjs'
import { run as eventTypesGroup } from './groups/126-event-types.mjs'
import { run as actionGroup } from './groups/127-action.mjs'
import { run as scaleTargetGroup } from './groups/128-scale-target.mjs'
import { run as actionPermissionGroup } from './groups/129-action-permission.mjs'
import { run as cdpHelpersGroup } from './groups/130-cdp-helpers.mjs'
import { run as testPromptGroup } from './groups/131-test-prompt.mjs'
import { run as planGateGroup } from './groups/132-plan-gate.mjs'
import { run as ipcChannelsGroup } from './groups/134-ipc-channels.mjs'
import { run as cdpGroup } from './groups/135-cdp.mjs'
import { run as browseReadGroup } from './groups/136-browse-read.mjs'
import { run as browseOpsGroup } from './groups/137-browse-ops.mjs'
import { run as browseHistoryGroup } from './groups/138-browse-history.mjs'
import { run as browseSettleGroup } from './groups/139-browse-settle.mjs'
import { run as shellHeartbeatGroup } from './groups/140-shell-heartbeat.mjs'
import { run as decisionEventNamesGroup } from './groups/141-decision-event-names.mjs'

/* ★ 顺序即运行顺序，保持既有次序不动 */
export const GROUPS = [
  basics, skillsMemory, fsSafety, reliability, agentLoop, promptState,
  switchWiringGroup, roundTranscriptGroup, llmBody, limits, browser, plugins,
  images, requires, imagesTool, taskContext, lifecycle, eventsBus, metrics, plan,
  abortTrace, streamBatch, resume, recovery, approval, errorKinds, autoRecover,
  continueAfterFail, continuity, fileCache, contextCache, taskName, sessionRedact,
  notify, confirmNotify, browseNotify, trayGroup, taskOutcome, checkpoint, diagnose,
  writeDiff, changesetDiff, perf, taskIndex, budgetGroup, loopGuard, consoleGroup,
  steeringGroup, pauseGroup, acceptanceGroup, purgeGroup, profileGroup,
  injectionGroup, pathEncoding, mcpPresets, interrupted, partialPersist, versionSync,
  taskReuse, answers, logging, actionLog, selectorStability, answerPick, destructive,
  redactFields, durableIntent, approvalCenter, tokenBadge, rollbackTo, artifactGroup,
  skillPerms, providerCaps, memoryExplain, scheduleGroup, netPolicyGroup,
  sessionCrypto, projectsGroup, taskPresets, consistencyGroup, boundsGroup, llmStream,
  handlersGroup, regenGroup, taskIsolationGroup, branchPathGroup, launchSummaryGroup,
  tokenOptGroup, visionGroup, modelChoiceGroup, browserWaitGroup, browseNavGroup,
  modelProbeGroup, errorObserverGroup, errorReaderGroup, machinePromptGroup,
  dataDoctorGroup, runStatsGroup, replayRiskGroup, projectRulesGroup,
  rollbackPreviewGroup, clarifyGroup, clarifyTimeoutGroup, confirmBridgeGroup,
  clarifyUnattendedGroup, clarifyWakeGroup, clarifyNoticeGroup, clarifyRuleGroup,
  acceptanceVerdictGroup, clarifyExitsGroup, scaleGateGroup, scaleConfigGroup,
  scalePromptGroup, probeGroup, verifyHintGroup, projectFactsGroup, memoryReflectGroup,
  memoryConflictGroup, projectCompleteGroup, urlPolicyGroup, safeWriteGroup,
  downloadGroup, editRulesGroup, subagentGroup, cardTimeoutGroup, decisionShapeGroup,
  eventTypesGroup, actionGroup, scaleTargetGroup, actionPermissionGroup,
  cdpHelpersGroup, testPromptGroup, planGateGroup, personaRoutingGroup, northStarGroup,
  strictModeGroup, markStepDoneGroup, memorySearchGroup, fsRootScopeGroup,
  promptSplitGroup, providerBalanceGroup, usageReasoningGroup, pricingGroup,
  browserIdentityGroup,
  userConstraintsGroup,
  nativeHostGroup,
  nativeHostInstallGroup,
  ipcChannelsGroup, cdpGroup, browseReadGroup, browseOpsGroup, browseHistoryGroup,
  browseSettleGroup, shellHeartbeatGroup, decisionEventNamesGroup,
  extBridgeGroup,
  extProtocolGroup,
  extChatGroup,
  observeGroup,
  extCommandGroup,
  actGroup,
  m04RestGroup,
  edgeToolsGroup,
  m02PanelGroup,
  codexAdapterGroup,
  codexStabilityGroup,
  probeIsolationGroup,
  testFixGroup,
  projectRootsGroup,
  collabGroup,
  collabStateGroup,
  downloadProgressGroup,
]
