// Generated file - DO NOT EDIT
// Source: constants.rs.genie.ts
// registry-source: genie/weaver-registry/registry.ts
// fingerprint: sha256:be52ef8dea5f20b50bc7f08a69fa2d42fcc9e3367d429203a52ab5261976561d
// regen: devenv tasks run genie:run

//! Generated OpenTelemetry semantic-convention name constants.

/// Attribute keys.
pub mod attribute {
    pub const ACME_ATTEMPT: &str = "acme.attempt";
    pub const ACME_PROBE_LABEL: &str = "acme.probe.label";
    pub const ACME_PROBE_NAME: &str = "acme.probe.name";
    pub const ACME_REGION: &str = "acme.region";
    pub const ACME_REQUEST_HEADER: &str = "acme.request.header";
    pub const CI_TOOLS_DEPLOY_ATTEMPT: &str = "ci_tools.deploy.attempt";
    pub const CI_TOOLS_DEPLOY_CLEANUP_ID: &str = "ci_tools.deploy.cleanup_id";
    pub const CI_TOOLS_DEPLOY_CLEANUP_STATUS: &str = "ci_tools.deploy.cleanup_status";
    pub const CI_TOOLS_DEPLOY_ERROR_KIND: &str = "ci_tools.deploy.error_kind";
    pub const CI_TOOLS_DEPLOY_MODE: &str = "ci_tools.deploy.mode";
    pub const CI_TOOLS_DEPLOY_OPERATION: &str = "ci_tools.deploy.operation";
    pub const CI_TOOLS_DEPLOY_PROVIDER: &str = "ci_tools.deploy.provider";
    pub const CI_TOOLS_DEPLOY_RUN_ID: &str = "ci_tools.deploy.run_id";
    pub const CI_TOOLS_DEPLOY_STATUS: &str = "ci_tools.deploy.status";
    pub const CI_TOOLS_DEPLOY_TARGET: &str = "ci_tools.deploy.target";
    pub const CI_TOOLS_DEPLOY_URL_HOST: &str = "ci_tools.deploy.url_host";
    pub const CLI_MODE: &str = "cli.mode";
    pub const CMD_ARGS: &str = "cmd.args";
    pub const CMD_COMMAND: &str = "cmd.command";
    pub const CMD_CWD: &str = "cmd.cwd";
    pub const CMD_LOG_DIR: &str = "cmd.log_dir";
    pub const CMD_LOG_PATH: &str = "cmd.log_path";
    pub const CMD_SHELL: &str = "cmd.shell";
    pub const GENIE_CONCURRENCY: &str = "genie.concurrency";
    pub const GENIE_CWD: &str = "genie.cwd";
    pub const GENIE_DRY_RUN: &str = "genie.dry_run";
    pub const GENIE_FILE_MODE: &str = "genie.file.mode";
    pub const GENIE_FILE_SOURCE_PATH: &str = "genie.file.source_path";
    pub const GENIE_FILE_TARGET_PATH: &str = "genie.file.target_path";
    pub const GENIE_OXFMT_HAS_CONFIG: &str = "genie.oxfmt.has_config";
    pub const GENIE_PATH: &str = "genie.path";
    pub const GENIE_READ_ONLY: &str = "genie.read_only";
    pub const GENIE_VALIDATION_FILE_COUNT: &str = "genie.validation.file_count";
    pub const GENIE_VALIDATION_PRELOADED_FILE_COUNT: &str = "genie.validation.preloaded_file_count";
    pub const GENIE_VALIDATION_REQUIRE_PACKAGE_JSON_VALIDATE: &str = "genie.validation.require_package_json_validate";
    pub const GIT_BARE: &str = "git.bare";
    pub const GIT_BRANCH: &str = "git.branch";
    pub const GIT_COMMIT: &str = "git.commit";
    pub const GIT_OUTPUT_BYTES: &str = "git.output.bytes";
    pub const GIT_OUTPUT_LINES: &str = "git.output.lines";
    pub const GIT_STREAMED: &str = "git.streamed";
    pub const GIT_SUBCOMMAND: &str = "git.subcommand";
    pub const GIT_TIMEOUT_MS: &str = "git.timeout_ms";
    pub const GIT_URL: &str = "git.url";
    pub const MEGAREPO_BRANCH: &str = "megarepo.branch";
    pub const MEGAREPO_CLI_ALL: &str = "megarepo.cli.all";
    pub const MEGAREPO_CLI_COMMAND: &str = "megarepo.cli.command";
    pub const MEGAREPO_CLI_DRY_RUN: &str = "megarepo.cli.dry_run";
    pub const MEGAREPO_CLI_FORCE: &str = "megarepo.cli.force";
    pub const MEGAREPO_CLI_OUTPUT: &str = "megarepo.cli.output";
    pub const MEGAREPO_CLI_PORCELAIN: &str = "megarepo.cli.porcelain";
    pub const MEGAREPO_MEMBER: &str = "megarepo.member";
    pub const MEGAREPO_REPO: &str = "megarepo.repo";
    pub const MEGAREPO_REPO_PATH: &str = "megarepo.repo_path";
    pub const MEGAREPO_REPO_ROOT: &str = "megarepo.repo_root";
    pub const MEGAREPO_ROOT: &str = "megarepo.root";
    pub const MEGAREPO_STORE_BARE_REPO_PATH: &str = "megarepo.store.bare_repo_path";
    pub const MEGAREPO_STORE_BASE_REF: &str = "megarepo.store.base_ref";
    pub const MEGAREPO_STORE_COMMIT: &str = "megarepo.store.commit";
    pub const MEGAREPO_STORE_GC_ARCHIVE_PATH: &str = "megarepo.store.gc.archive_path";
    pub const MEGAREPO_STORE_GC_ARCHIVE_REASON: &str = "megarepo.store.gc.archive_reason";
    pub const MEGAREPO_STORE_GC_CANDIDATE_COMMITS: &str = "megarepo.store.gc.candidate_commits";
    pub const MEGAREPO_STORE_GC_CANDIDATE_NAMED_REFS: &str = "megarepo.store.gc.candidate_named_refs";
    pub const MEGAREPO_STORE_GC_PHASE: &str = "megarepo.store.gc.phase";
    pub const MEGAREPO_STORE_GC_POLICY: &str = "megarepo.store.gc.policy";
    pub const MEGAREPO_STORE_GC_REPO_CONCURRENCY: &str = "megarepo.store.gc.repo_concurrency";
    pub const MEGAREPO_STORE_GC_REPO_COUNT: &str = "megarepo.store.gc.repo_count";
    pub const MEGAREPO_STORE_GC_REPO_TOTAL: &str = "megarepo.store.gc.repo_total";
    pub const MEGAREPO_STORE_GC_RESULT_ARCHIVED: &str = "megarepo.store.gc.result_archived";
    pub const MEGAREPO_STORE_GC_RESULT_KEPT: &str = "megarepo.store.gc.result_kept";
    pub const MEGAREPO_STORE_GC_RESULT_REAPED: &str = "megarepo.store.gc.result_reaped";
    pub const MEGAREPO_STORE_GC_RESULT_REMOVED: &str = "megarepo.store.gc.result_removed";
    pub const MEGAREPO_STORE_GC_RESULT_SKIPPED_DIRTY: &str = "megarepo.store.gc.result_skipped_dirty";
    pub const MEGAREPO_STORE_GC_RESULT_SKIPPED_IN_USE: &str = "megarepo.store.gc.result_skipped_in_use";
    pub const MEGAREPO_STORE_GC_RESULT_TOTAL: &str = "megarepo.store.gc.result_total";
    pub const MEGAREPO_STORE_GC_ROOT_SET_WORKSPACE_COUNT: &str = "megarepo.store.gc.root_set_workspace_count";
    pub const MEGAREPO_STORE_GC_WORKTREE_COUNT: &str = "megarepo.store.gc.worktree_count";
    pub const MEGAREPO_STORE_GC_WORKTREE_DISCOVERED: &str = "megarepo.store.gc.worktree_discovered";
    pub const MEGAREPO_STORE_GIT_WORKTREE_LIST_FAILED: &str = "megarepo.store.git_worktree_list_failed";
    pub const MEGAREPO_STORE_HAS_CURRENT_WORKSPACE: &str = "megarepo.store.has_current_workspace";
    pub const MEGAREPO_STORE_PRUNE_STALE_REGISTRY: &str = "megarepo.store.prune_stale_registry";
    pub const MEGAREPO_STORE_REF: &str = "megarepo.store.ref";
    pub const MEGAREPO_STORE_REF_TYPE: &str = "megarepo.store.ref_type";
    pub const MEGAREPO_STORE_REFRESH_CURRENT_WORKSPACE: &str = "megarepo.store.refresh_current_workspace";
    pub const MEGAREPO_STORE_REPO: &str = "megarepo.store.repo";
    pub const MEGAREPO_STORE_SOURCE: &str = "megarepo.store.source";
    pub const MEGAREPO_STORE_WORKTREE_BROKEN: &str = "megarepo.store.worktree_broken";
    pub const MEGAREPO_STORE_WORKTREE_PATH: &str = "megarepo.store.worktree_path";
    pub const MEGAREPO_SYNC_DEPTH: &str = "megarepo.sync.depth";
    pub const MEGAREPO_SYNC_MEMBER_ACTION: &str = "megarepo.sync.member.action";
    pub const MEGAREPO_SYNC_MEMBER_BARE_EXISTS: &str = "megarepo.sync.member.bare_exists";
    pub const MEGAREPO_SYNC_MEMBER_NAME: &str = "megarepo.sync.member.name";
    pub const MEGAREPO_SYNC_MEMBER_REF: &str = "megarepo.sync.member.ref";
    pub const MEGAREPO_SYNC_MEMBER_REF_TYPE: &str = "megarepo.sync.member.ref_type";
    pub const MEGAREPO_SYNC_MEMBER_RESULT_STATUS: &str = "megarepo.sync.member.result_status";
    pub const MEGAREPO_SYNC_MEMBER_SOURCE: &str = "megarepo.sync.member.source";
    pub const MEGAREPO_SYNC_MODE: &str = "megarepo.sync.mode";
    pub const MEGAREPO_TEST_STORE_FIXTURE_BRANCH_COUNT: &str = "megarepo.test.store_fixture.branch_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_COMMIT_COUNT: &str = "megarepo.test.store_fixture.commit_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_PHASE: &str = "megarepo.test.store_fixture.phase";
    pub const MEGAREPO_TEST_STORE_FIXTURE_REPO: &str = "megarepo.test.store_fixture.repo";
    pub const MEGAREPO_TEST_STORE_FIXTURE_REPO_COUNT: &str = "megarepo.test.store_fixture.repo_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_TAG_COUNT: &str = "megarepo.test.store_fixture.tag_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_WITH_REMOTE: &str = "megarepo.test.store_fixture.with_remote";
    pub const MEGAREPO_TRAVERSAL_ALL: &str = "megarepo.traversal.all";
    pub const MEGAREPO_TRAVERSAL_CYCLES_SKIPPED: &str = "megarepo.traversal.cycles_skipped";
    pub const MEGAREPO_TRAVERSAL_MAX_DEPTH: &str = "megarepo.traversal.max_depth";
    pub const MEGAREPO_TRAVERSAL_NODES_VISITED: &str = "megarepo.traversal.nodes_visited";
    pub const MEGAREPO_TRAVERSAL_PURPOSE: &str = "megarepo.traversal.purpose";
    pub const MEGAREPO_TRAVERSAL_ROOT: &str = "megarepo.traversal.root";
    pub const MEGAREPO_WORKSPACE_ROOT: &str = "megarepo.workspace_root";
    pub const MEGAREPO_WORKTREE_HEAD: &str = "megarepo.worktree_head";
    pub const MEGAREPO_WORKTREE_PATH: &str = "megarepo.worktree_path";
    pub const NIX_FLAKE_OWNER: &str = "nix.flake.owner";
    pub const NIX_FLAKE_REPO: &str = "nix.flake.repo";
    pub const NIX_FLAKE_REV: &str = "nix.flake.rev";
    pub const NIX_LOCK_PATH: &str = "nix.lock.path";
    pub const NIX_LOCK_SOURCE_PATH: &str = "nix.lock.source_path";
    pub const NIX_LOCK_SOURCE_TYPE: &str = "nix.lock.source_type";
    pub const NIX_LOCK_TYPE: &str = "nix.lock.type";
    pub const NOTION_DATASOURCE_API_VERSION: &str = "notion_datasource.api_version";
    pub const NOTION_DATASOURCE_APPENDED_EVENTS: &str = "notion_datasource.appended_events";
    pub const NOTION_DATASOURCE_ATTEMPT: &str = "notion_datasource.attempt";
    pub const NOTION_DATASOURCE_BLOCKED_COUNT: &str = "notion_datasource.blocked_count";
    pub const NOTION_DATASOURCE_BODY_COMPLETENESS: &str = "notion_datasource.body.completeness";
    pub const NOTION_DATASOURCE_BODY_EVIDENCE_DIGEST: &str = "notion_datasource.body.evidence.digest";
    pub const NOTION_DATASOURCE_BODY_IDENTITY_DIGEST: &str = "notion_datasource.body.identity.digest";
    pub const NOTION_DATASOURCE_BODY_IDENTITY_KIND: &str = "notion_datasource.body.identity.kind";
    pub const NOTION_DATASOURCE_BODY_RENDERED_DIGEST: &str = "notion_datasource.body.rendered.digest";
    pub const NOTION_DATASOURCE_CANCELLED: &str = "notion_datasource.cancelled";
    pub const NOTION_DATASOURCE_CAPPED_AT_LIMIT: &str = "notion_datasource.capped_at_limit";
    pub const NOTION_DATASOURCE_COMMAND: &str = "notion_datasource.command";
    pub const NOTION_DATASOURCE_COMMAND_ID: &str = "notion_datasource.command_id";
    pub const NOTION_DATASOURCE_COMMAND_KIND: &str = "notion_datasource.command_kind";
    pub const NOTION_DATASOURCE_COMPLETED_CYCLES: &str = "notion_datasource.completed_cycles";
    pub const NOTION_DATASOURCE_CONFLICT_COUNT: &str = "notion_datasource.conflict_count";
    pub const NOTION_DATASOURCE_CYCLE: &str = "notion_datasource.cycle";
    pub const NOTION_DATASOURCE_CYCLES: &str = "notion_datasource.cycles";
    pub const NOTION_DATASOURCE_DATA_SOURCE_ID: &str = "notion_datasource.data_source_id";
    pub const NOTION_DATASOURCE_DRY_RUN: &str = "notion_datasource.dry_run";
    pub const NOTION_DATASOURCE_ENQUEUED_COMMANDS: &str = "notion_datasource.enqueued_commands";
    pub const NOTION_DATASOURCE_EVENT_COUNT: &str = "notion_datasource.event_count";
    pub const NOTION_DATASOURCE_EXECUTOR_STEPS: &str = "notion_datasource.executor_steps";
    pub const NOTION_DATASOURCE_GUARD: &str = "notion_datasource.guard";
    pub const NOTION_DATASOURCE_INCOMPLETE_PROPERTY_COUNT: &str = "notion_datasource.incomplete_property_count";
    pub const NOTION_DATASOURCE_LEASE_DURATION_MS: &str = "notion_datasource.lease_duration_ms";
    pub const NOTION_DATASOURCE_LOCAL_OBSERVATION_COUNT: &str = "notion_datasource.local_observation_count";
    pub const NOTION_DATASOURCE_MAX_CYCLES: &str = "notion_datasource.max_cycles";
    pub const NOTION_DATASOURCE_MAX_EXECUTOR_STEPS: &str = "notion_datasource.max_executor_steps";
    pub const NOTION_DATASOURCE_MAX_STEPS_REACHED: &str = "notion_datasource.max_steps_reached";
    pub const NOTION_DATASOURCE_MODE: &str = "notion_datasource.mode";
    pub const NOTION_DATASOURCE_OPERATION: &str = "notion_datasource.operation";
    pub const NOTION_DATASOURCE_OUTBOX_AMBIGUOUS_COUNT: &str = "notion_datasource.outbox_ambiguous_count";
    pub const NOTION_DATASOURCE_OUTBOX_BLOCKED_COUNT: &str = "notion_datasource.outbox_blocked_count";
    pub const NOTION_DATASOURCE_OUTBOX_QUEUED_COUNT: &str = "notion_datasource.outbox_queued_count";
    pub const NOTION_DATASOURCE_OUTBOX_RETRYABLE_COUNT: &str = "notion_datasource.outbox_retryable_count";
    pub const NOTION_DATASOURCE_OUTBOX_RUNNING_COUNT: &str = "notion_datasource.outbox_running_count";
    pub const NOTION_DATASOURCE_PAGE_ID: &str = "notion_datasource.page_id";
    pub const NOTION_DATASOURCE_PROCESS_ROLE: &str = "notion_datasource.process.role";
    pub const NOTION_DATASOURCE_PROPERTY_ID: &str = "notion_datasource.property_id";
    pub const NOTION_DATASOURCE_QUERY_COMPLETE: &str = "notion_datasource.query_complete";
    pub const NOTION_DATASOURCE_QUERY_PAGE_COUNT: &str = "notion_datasource.query_page_count";
    pub const NOTION_DATASOURCE_RESULT: &str = "notion_datasource.result";
    pub const NOTION_DATASOURCE_ROOT_ID: &str = "notion_datasource.root_id";
    pub const NOTION_DATASOURCE_ROW_COUNT: &str = "notion_datasource.row_count";
    pub const NOTION_DATASOURCE_SETTLEMENT_KIND: &str = "notion_datasource.settlement_kind";
    pub const NOTION_DATASOURCE_STATUS_STATE: &str = "notion_datasource.status.state";
    pub const NOTION_DATASOURCE_WAKE_SOURCE: &str = "notion_datasource.wake_source";
    pub const NOTION_DATASOURCE_WEBHOOK_EVENT_TYPE: &str = "notion_datasource.webhook.event_type";
    pub const NOTION_DATASOURCE_WEBHOOK_OUTCOME: &str = "notion_datasource.webhook.outcome";
    pub const NOTION_DATASOURCE_WEBHOOK_REJECTION_REASON: &str = "notion_datasource.webhook.rejection_reason";
    pub const NOTION_MD_BATCH: &str = "notion_md.batch";
    pub const NOTION_MD_BATCH_PATH_COUNT: &str = "notion_md.batch.path_count";
    pub const NOTION_MD_BATCH_RECURSIVE: &str = "notion_md.batch.recursive";
    pub const NOTION_MD_BATCH_TARGET_COUNT: &str = "notion_md.batch.target_count";
    pub const NOTION_MD_COMMAND: &str = "notion_md.command";
    pub const NOTION_MD_COMMENT_BOUNDARY_COMMENT_COUNT: &str = "notion_md.comment_boundary.comment_count";
    pub const NOTION_MD_COMMENT_BOUNDARY_GUARD: &str = "notion_md.comment_boundary.guard";
    pub const NOTION_MD_COMMENT_BOUNDARY_OPERATION: &str = "notion_md.comment_boundary.operation";
    pub const NOTION_MD_COMMENT_BOUNDARY_VERDICT: &str = "notion_md.comment_boundary.verdict";
    pub const NOTION_MD_DATA_SOURCE_ID: &str = "notion_md.data_source_id";
    pub const NOTION_MD_DESTRUCTIVE_BODY_BLOCK_COUNT: &str = "notion_md.destructive_body.block_count";
    pub const NOTION_MD_DESTRUCTIVE_BODY_GUARD: &str = "notion_md.destructive_body.guard";
    pub const NOTION_MD_DESTRUCTIVE_BODY_VERDICT: &str = "notion_md.destructive_body.verdict";
    pub const NOTION_MD_EDIT_OUTCOME: &str = "notion_md.edit.outcome";
    pub const NOTION_MD_EDITOR_MODE: &str = "notion_md.editor.mode";
    pub const NOTION_MD_MARKDOWN_UPDATE_ALLOW_DELETING_CONTENT: &str = "notion_md.markdown_update.allow_deleting_content";
    pub const NOTION_MD_MARKDOWN_UPDATE_CONTENT_UPDATE_COUNT: &str = "notion_md.markdown_update.content_update_count";
    pub const NOTION_MD_MARKDOWN_UPDATE_TYPE: &str = "notion_md.markdown_update.type";
    pub const NOTION_MD_MEDIA_BOUNDARY_FILE_COUNT: &str = "notion_md.media_boundary.file_count";
    pub const NOTION_MD_MEDIA_BOUNDARY_GUARD: &str = "notion_md.media_boundary.guard";
    pub const NOTION_MD_MEDIA_BOUNDARY_OPERATION: &str = "notion_md.media_boundary.operation";
    pub const NOTION_MD_MEDIA_BOUNDARY_VERDICT: &str = "notion_md.media_boundary.verdict";
    pub const NOTION_MD_OBJECT_GC_DRY_RUN: &str = "notion_md.object_gc.dry_run";
    pub const NOTION_MD_OBJECT_GC_REACHABLE_COUNT: &str = "notion_md.object_gc.reachable_count";
    pub const NOTION_MD_OBJECT_GC_REMOVED_COUNT: &str = "notion_md.object_gc.removed_count";
    pub const NOTION_MD_OBJECT_HASH_PREFIX: &str = "notion_md.object.hash_prefix";
    pub const NOTION_MD_OBJECT_ROLE: &str = "notion_md.object.role";
    pub const NOTION_MD_PAGE_ID: &str = "notion_md.page_id";
    pub const NOTION_MD_PAGE_METADATA_COVER: &str = "notion_md.page_metadata.cover";
    pub const NOTION_MD_PAGE_METADATA_ICON: &str = "notion_md.page_metadata.icon";
    pub const NOTION_MD_PAGE_METADATA_IN_TRASH: &str = "notion_md.page_metadata.in_trash";
    pub const NOTION_MD_PAGE_METADATA_IS_LOCKED: &str = "notion_md.page_metadata.is_locked";
    pub const NOTION_MD_PAGE_METADATA_TITLE: &str = "notion_md.page_metadata.title";
    pub const NOTION_MD_PARENT_PAGE_ID: &str = "notion_md.parent_page_id";
    pub const NOTION_MD_PATH_BASENAME: &str = "notion_md.path.basename";
    pub const NOTION_MD_PATH_RECURSIVE: &str = "notion_md.path.recursive";
    pub const NOTION_MD_PUSH_ALLOW_DELETE_UNKNOWN_BLOCKS: &str = "notion_md.push.allow_delete_unknown_blocks";
    pub const NOTION_MD_PUSH_DECISION: &str = "notion_md.push.decision";
    pub const NOTION_MD_PUSH_FORCE: &str = "notion_md.push.force";
    pub const NOTION_MD_PUSH_MARKDOWN_COMMAND: &str = "notion_md.push.markdown_command";
    pub const NOTION_MD_PUSH_PUSHED: &str = "notion_md.push.pushed";
    pub const NOTION_MD_PUT_BODY_WRITTEN: &str = "notion_md.put.body_written";
    pub const NOTION_MD_PUT_FORCE: &str = "notion_md.put.force";
    pub const NOTION_MD_PUT_TITLE_WRITTEN: &str = "notion_md.put.title_written";
    pub const NOTION_MD_STATE_OPERATION: &str = "notion_md.state.operation";
    pub const NOTION_MD_STATUS_LOCAL_CHANGED: &str = "notion_md.status.local_changed";
    pub const NOTION_MD_STATUS_LOCAL_PAGE_METADATA_CHANGED: &str = "notion_md.status.local_page_metadata_changed";
    pub const NOTION_MD_STATUS_LOCAL_PROPERTIES_CHANGED: &str = "notion_md.status.local_properties_changed";
    pub const NOTION_MD_STATUS_REMOTE_BODY_CHANGED: &str = "notion_md.status.remote_body_changed";
    pub const NOTION_MD_STATUS_REMOTE_CHANGED: &str = "notion_md.status.remote_changed";
    pub const NOTION_MD_STATUS_REMOTE_PAGE_METADATA_CHANGED: &str = "notion_md.status.remote_page_metadata_changed";
    pub const NOTION_MD_STATUS_UNKNOWN_BLOCK_COUNT: &str = "notion_md.status.unknown_block_count";
    pub const NOTION_MD_SYNC_ERROR: &str = "notion_md.sync.error";
    pub const NOTION_MD_SYNC_ERROR_TAG: &str = "notion_md.sync.error_tag";
    pub const NOTION_MD_SYNC_RESULT: &str = "notion_md.sync.result";
    pub const NOTION_MD_TRACK_SOURCE: &str = "notion_md.track.source";
    pub const NOTION_MD_TREE_FROM_REMOTE: &str = "notion_md.tree.from_remote";
    pub const NOTION_MD_TREE_PLAN: &str = "notion_md.tree.plan";
    pub const NOTION_MD_WATCH: &str = "notion_md.watch";
    pub const NOTION_MD_WATCH_REASON: &str = "notion_md.watch.reason";
    pub const NOTION_MD_WEBHOOK_EVENT_TYPE: &str = "notion_md.webhook.event_type";
    pub const NOTION_MD_WEBHOOK_SURFACE: &str = "notion_md.webhook.surface";
    pub const NOTION_MD_WEBHOOK_TRIGGER_COUNT: &str = "notion_md.webhook.trigger_count";
    pub const NOTION_REACT_BATCH_BATCHED: &str = "notion-react.batch.batched";
    pub const NOTION_REACT_BATCH_ISSUED: &str = "notion-react.batch.issued";
    pub const NOTION_REACT_BLOCK_ID: &str = "notion-react.block_id";
    pub const NOTION_REACT_CHECKPOINT_BYTES: &str = "notion-react.checkpoint.bytes";
    pub const NOTION_REACT_DURATION_MS: &str = "notion-react.duration_ms";
    pub const NOTION_REACT_FALLBACK_REASON: &str = "notion-react.fallback_reason";
    pub const NOTION_REACT_NOOP_REASON: &str = "notion-react.noop_reason";
    pub const NOTION_REACT_OK: &str = "notion-react.ok";
    pub const NOTION_REACT_OP_COUNT: &str = "notion-react.op_count";
    pub const NOTION_REACT_OP_DURATION_MS: &str = "notion-react.op.duration_ms";
    pub const NOTION_REACT_OP_ERROR: &str = "notion-react.op.error";
    pub const NOTION_REACT_OP_ID: &str = "notion-react.op.id";
    pub const NOTION_REACT_OP_KIND: &str = "notion-react.op.kind";
    pub const NOTION_REACT_OP_NOTE: &str = "notion-react.op.note";
    pub const NOTION_REACT_OP_RESULT_COUNT: &str = "notion-react.op.result_count";
    pub const NOTION_REACT_PAGE_ID: &str = "notion-react.page_id";
    pub const NOTION_REACT_ROOT_BLOCK_COUNT: &str = "notion-react.root_block_count";
    pub const NOTION_DATA_SOURCE_ID: &str = "notion.data_source_id";
    pub const NOTION_HTTP_METHOD: &str = "notion.http.method";
    pub const NOTION_HTTP_OPERATION: &str = "notion.http.operation";
    pub const NOTION_HTTP_RETRY_ATTEMPT: &str = "notion.http.retry.attempt";
    pub const NOTION_HTTP_RETRY_ATTEMPTS: &str = "notion.http.retry.attempts";
    pub const NOTION_HTTP_RETRY_DELAY_MS: &str = "notion.http.retry.delay_ms";
    pub const NOTION_HTTP_ROUTE: &str = "notion.http.route";
    pub const NOTION_HTTP_STATUS_CODE: &str = "notion.http.status_code";
    pub const NOTION_PAGE_ID: &str = "notion.page_id";
    pub const NOTION_QUOTA_COST: &str = "notion.quota.cost";
    pub const NOTION_RATE_LIMIT_PRESENT: &str = "notion.rate_limit.present";
    pub const NOTION_RATE_LIMIT_REMAINING: &str = "notion.rate_limit.remaining";
    pub const NOTION_RATE_LIMIT_RESET_AFTER_MS: &str = "notion.rate_limit.reset_after_ms";
    pub const NOTION_RATE_LIMIT_WAIT_MS: &str = "notion.rate_limit.wait_ms";
    pub const PTY_NAME: &str = "pty.name";
    pub const PTY_SESSION_MODE: &str = "pty.session.mode";
    pub const PTY_WAIT_NEEDLE: &str = "pty.wait.needle";
    pub const PW_COOKIE_COUNT: &str = "pw.cookie.count";
    pub const PW_COOKIES_URL: &str = "pw.cookies.url";
    pub const PW_DELAY_MS: &str = "pw.delay.ms";
    pub const PW_EXPECT_ASSERTION: &str = "pw.expect.assertion";
    pub const PW_JITTER_MS: &str = "pw.jitter.ms";
    pub const PW_JITTER_MSMAX: &str = "pw.jitter.msMax";
    pub const PW_JITTER_MSMIN: &str = "pw.jitter.msMin";
    pub const PW_KEY: &str = "pw.key";
    pub const PW_LABEL: &str = "pw.label";
    pub const PW_LOADSTATE: &str = "pw.loadState";
    pub const PW_NAME: &str = "pw.name";
    pub const PW_OP: &str = "pw.op";
    pub const PW_PLACEHOLDER: &str = "pw.placeholder";
    pub const PW_ROLE: &str = "pw.role";
    pub const PW_SCREENSHOT_FULLPAGE: &str = "pw.screenshot.fullPage";
    pub const PW_SCREENSHOT_PATH: &str = "pw.screenshot.path";
    pub const PW_SELECTOR: &str = "pw.selector";
    pub const PW_STEP: &str = "pw.step";
    pub const PW_STEP_NAME: &str = "pw.step.name";
    pub const PW_STEP_PARENTSPAN__TAG: &str = "pw.step.parentSpan._tag";
    pub const PW_STORAGESTATE_PATH: &str = "pw.storageState.path";
    pub const PW_TESTID: &str = "pw.testId";
    pub const PW_TEXT: &str = "pw.text";
    pub const PW_TEXT_LEN: &str = "pw.text.len";
    pub const PW_TIMEOUT_MS: &str = "pw.timeout.ms";
    pub const PW_TRY_OP: &str = "pw.try.op";
    pub const PW_URL: &str = "pw.url";
    pub const PW_URLMATCH: &str = "pw.urlMatch";
    pub const PW_VALUE_LEN: &str = "pw.value.len";
    pub const PW_VIEWPORT_HEIGHT: &str = "pw.viewport.height";
    pub const PW_VIEWPORT_WIDTH: &str = "pw.viewport.width";
    pub const PW_WAIT_ATTEMPT: &str = "pw.wait.attempt";
    pub const PW_WAIT_LABEL: &str = "pw.wait.label";
    pub const PW_WAIT_POLLINTERVAL: &str = "pw.wait.pollInterval";
    pub const PW_WAIT_TIMEOUT: &str = "pw.wait.timeout";
    pub const PW_WAITUNTIL: &str = "pw.waitUntil";
    pub const RESTATE_ERROR_CLASS: &str = "restate.error.class";
    pub const RESTATE_ERROR_TAG: &str = "restate.error.tag";
    pub const RESTATE_HANDLER: &str = "restate.handler";
    pub const RESTATE_IDEMPOTENCY_KEY: &str = "restate.idempotency.key";
    pub const RESTATE_NAME: &str = "restate.name";
    pub const RESTATE_OBJECT_KEY: &str = "restate.object.key";
    pub const RESTATE_OUTCOME: &str = "restate.outcome";
    pub const RESTATE_SERVICE: &str = "restate.service";
    pub const RESTATE_STEP: &str = "restate.step";
    pub const RESTATE_WORKFLOW_ID: &str = "restate.workflow.id";
    pub const SEMAPHORE_KEY: &str = "semaphore.key";
    pub const SEMAPHORE_TARGET_HOLDER_ID: &str = "semaphore.target_holder_id";

    pub const ALL: &[&str] = &[
        "acme.attempt",
        "acme.probe.label",
        "acme.probe.name",
        "acme.region",
        "acme.request.header",
        "ci_tools.deploy.attempt",
        "ci_tools.deploy.cleanup_id",
        "ci_tools.deploy.cleanup_status",
        "ci_tools.deploy.error_kind",
        "ci_tools.deploy.mode",
        "ci_tools.deploy.operation",
        "ci_tools.deploy.provider",
        "ci_tools.deploy.run_id",
        "ci_tools.deploy.status",
        "ci_tools.deploy.target",
        "ci_tools.deploy.url_host",
        "cli.mode",
        "cmd.args",
        "cmd.command",
        "cmd.cwd",
        "cmd.log_dir",
        "cmd.log_path",
        "cmd.shell",
        "genie.concurrency",
        "genie.cwd",
        "genie.dry_run",
        "genie.file.mode",
        "genie.file.source_path",
        "genie.file.target_path",
        "genie.oxfmt.has_config",
        "genie.path",
        "genie.read_only",
        "genie.validation.file_count",
        "genie.validation.preloaded_file_count",
        "genie.validation.require_package_json_validate",
        "git.bare",
        "git.branch",
        "git.commit",
        "git.output.bytes",
        "git.output.lines",
        "git.streamed",
        "git.subcommand",
        "git.timeout_ms",
        "git.url",
        "megarepo.branch",
        "megarepo.cli.all",
        "megarepo.cli.command",
        "megarepo.cli.dry_run",
        "megarepo.cli.force",
        "megarepo.cli.output",
        "megarepo.cli.porcelain",
        "megarepo.member",
        "megarepo.repo",
        "megarepo.repo_path",
        "megarepo.repo_root",
        "megarepo.root",
        "megarepo.store.bare_repo_path",
        "megarepo.store.base_ref",
        "megarepo.store.commit",
        "megarepo.store.gc.archive_path",
        "megarepo.store.gc.archive_reason",
        "megarepo.store.gc.candidate_commits",
        "megarepo.store.gc.candidate_named_refs",
        "megarepo.store.gc.phase",
        "megarepo.store.gc.policy",
        "megarepo.store.gc.repo_concurrency",
        "megarepo.store.gc.repo_count",
        "megarepo.store.gc.repo_total",
        "megarepo.store.gc.result_archived",
        "megarepo.store.gc.result_kept",
        "megarepo.store.gc.result_reaped",
        "megarepo.store.gc.result_removed",
        "megarepo.store.gc.result_skipped_dirty",
        "megarepo.store.gc.result_skipped_in_use",
        "megarepo.store.gc.result_total",
        "megarepo.store.gc.root_set_workspace_count",
        "megarepo.store.gc.worktree_count",
        "megarepo.store.gc.worktree_discovered",
        "megarepo.store.git_worktree_list_failed",
        "megarepo.store.has_current_workspace",
        "megarepo.store.prune_stale_registry",
        "megarepo.store.ref",
        "megarepo.store.ref_type",
        "megarepo.store.refresh_current_workspace",
        "megarepo.store.repo",
        "megarepo.store.source",
        "megarepo.store.worktree_broken",
        "megarepo.store.worktree_path",
        "megarepo.sync.depth",
        "megarepo.sync.member.action",
        "megarepo.sync.member.bare_exists",
        "megarepo.sync.member.name",
        "megarepo.sync.member.ref",
        "megarepo.sync.member.ref_type",
        "megarepo.sync.member.result_status",
        "megarepo.sync.member.source",
        "megarepo.sync.mode",
        "megarepo.test.store_fixture.branch_count",
        "megarepo.test.store_fixture.commit_count",
        "megarepo.test.store_fixture.phase",
        "megarepo.test.store_fixture.repo",
        "megarepo.test.store_fixture.repo_count",
        "megarepo.test.store_fixture.tag_count",
        "megarepo.test.store_fixture.with_remote",
        "megarepo.traversal.all",
        "megarepo.traversal.cycles_skipped",
        "megarepo.traversal.max_depth",
        "megarepo.traversal.nodes_visited",
        "megarepo.traversal.purpose",
        "megarepo.traversal.root",
        "megarepo.workspace_root",
        "megarepo.worktree_head",
        "megarepo.worktree_path",
        "nix.flake.owner",
        "nix.flake.repo",
        "nix.flake.rev",
        "nix.lock.path",
        "nix.lock.source_path",
        "nix.lock.source_type",
        "nix.lock.type",
        "notion_datasource.api_version",
        "notion_datasource.appended_events",
        "notion_datasource.attempt",
        "notion_datasource.blocked_count",
        "notion_datasource.body.completeness",
        "notion_datasource.body.evidence.digest",
        "notion_datasource.body.identity.digest",
        "notion_datasource.body.identity.kind",
        "notion_datasource.body.rendered.digest",
        "notion_datasource.cancelled",
        "notion_datasource.capped_at_limit",
        "notion_datasource.command",
        "notion_datasource.command_id",
        "notion_datasource.command_kind",
        "notion_datasource.completed_cycles",
        "notion_datasource.conflict_count",
        "notion_datasource.cycle",
        "notion_datasource.cycles",
        "notion_datasource.data_source_id",
        "notion_datasource.dry_run",
        "notion_datasource.enqueued_commands",
        "notion_datasource.event_count",
        "notion_datasource.executor_steps",
        "notion_datasource.guard",
        "notion_datasource.incomplete_property_count",
        "notion_datasource.lease_duration_ms",
        "notion_datasource.local_observation_count",
        "notion_datasource.max_cycles",
        "notion_datasource.max_executor_steps",
        "notion_datasource.max_steps_reached",
        "notion_datasource.mode",
        "notion_datasource.operation",
        "notion_datasource.outbox_ambiguous_count",
        "notion_datasource.outbox_blocked_count",
        "notion_datasource.outbox_queued_count",
        "notion_datasource.outbox_retryable_count",
        "notion_datasource.outbox_running_count",
        "notion_datasource.page_id",
        "notion_datasource.process.role",
        "notion_datasource.property_id",
        "notion_datasource.query_complete",
        "notion_datasource.query_page_count",
        "notion_datasource.result",
        "notion_datasource.root_id",
        "notion_datasource.row_count",
        "notion_datasource.settlement_kind",
        "notion_datasource.status.state",
        "notion_datasource.wake_source",
        "notion_datasource.webhook.event_type",
        "notion_datasource.webhook.outcome",
        "notion_datasource.webhook.rejection_reason",
        "notion_md.batch",
        "notion_md.batch.path_count",
        "notion_md.batch.recursive",
        "notion_md.batch.target_count",
        "notion_md.command",
        "notion_md.comment_boundary.comment_count",
        "notion_md.comment_boundary.guard",
        "notion_md.comment_boundary.operation",
        "notion_md.comment_boundary.verdict",
        "notion_md.data_source_id",
        "notion_md.destructive_body.block_count",
        "notion_md.destructive_body.guard",
        "notion_md.destructive_body.verdict",
        "notion_md.edit.outcome",
        "notion_md.editor.mode",
        "notion_md.markdown_update.allow_deleting_content",
        "notion_md.markdown_update.content_update_count",
        "notion_md.markdown_update.type",
        "notion_md.media_boundary.file_count",
        "notion_md.media_boundary.guard",
        "notion_md.media_boundary.operation",
        "notion_md.media_boundary.verdict",
        "notion_md.object_gc.dry_run",
        "notion_md.object_gc.reachable_count",
        "notion_md.object_gc.removed_count",
        "notion_md.object.hash_prefix",
        "notion_md.object.role",
        "notion_md.page_id",
        "notion_md.page_metadata.cover",
        "notion_md.page_metadata.icon",
        "notion_md.page_metadata.in_trash",
        "notion_md.page_metadata.is_locked",
        "notion_md.page_metadata.title",
        "notion_md.parent_page_id",
        "notion_md.path.basename",
        "notion_md.path.recursive",
        "notion_md.push.allow_delete_unknown_blocks",
        "notion_md.push.decision",
        "notion_md.push.force",
        "notion_md.push.markdown_command",
        "notion_md.push.pushed",
        "notion_md.put.body_written",
        "notion_md.put.force",
        "notion_md.put.title_written",
        "notion_md.state.operation",
        "notion_md.status.local_changed",
        "notion_md.status.local_page_metadata_changed",
        "notion_md.status.local_properties_changed",
        "notion_md.status.remote_body_changed",
        "notion_md.status.remote_changed",
        "notion_md.status.remote_page_metadata_changed",
        "notion_md.status.unknown_block_count",
        "notion_md.sync.error",
        "notion_md.sync.error_tag",
        "notion_md.sync.result",
        "notion_md.track.source",
        "notion_md.tree.from_remote",
        "notion_md.tree.plan",
        "notion_md.watch",
        "notion_md.watch.reason",
        "notion_md.webhook.event_type",
        "notion_md.webhook.surface",
        "notion_md.webhook.trigger_count",
        "notion-react.batch.batched",
        "notion-react.batch.issued",
        "notion-react.block_id",
        "notion-react.checkpoint.bytes",
        "notion-react.duration_ms",
        "notion-react.fallback_reason",
        "notion-react.noop_reason",
        "notion-react.ok",
        "notion-react.op_count",
        "notion-react.op.duration_ms",
        "notion-react.op.error",
        "notion-react.op.id",
        "notion-react.op.kind",
        "notion-react.op.note",
        "notion-react.op.result_count",
        "notion-react.page_id",
        "notion-react.root_block_count",
        "notion.data_source_id",
        "notion.http.method",
        "notion.http.operation",
        "notion.http.retry.attempt",
        "notion.http.retry.attempts",
        "notion.http.retry.delay_ms",
        "notion.http.route",
        "notion.http.status_code",
        "notion.page_id",
        "notion.quota.cost",
        "notion.rate_limit.present",
        "notion.rate_limit.remaining",
        "notion.rate_limit.reset_after_ms",
        "notion.rate_limit.wait_ms",
        "pty.name",
        "pty.session.mode",
        "pty.wait.needle",
        "pw.cookie.count",
        "pw.cookies.url",
        "pw.delay.ms",
        "pw.expect.assertion",
        "pw.jitter.ms",
        "pw.jitter.msMax",
        "pw.jitter.msMin",
        "pw.key",
        "pw.label",
        "pw.loadState",
        "pw.name",
        "pw.op",
        "pw.placeholder",
        "pw.role",
        "pw.screenshot.fullPage",
        "pw.screenshot.path",
        "pw.selector",
        "pw.step",
        "pw.step.name",
        "pw.step.parentSpan._tag",
        "pw.storageState.path",
        "pw.testId",
        "pw.text",
        "pw.text.len",
        "pw.timeout.ms",
        "pw.try.op",
        "pw.url",
        "pw.urlMatch",
        "pw.value.len",
        "pw.viewport.height",
        "pw.viewport.width",
        "pw.wait.attempt",
        "pw.wait.label",
        "pw.wait.pollInterval",
        "pw.wait.timeout",
        "pw.waitUntil",
        "restate.error.class",
        "restate.error.tag",
        "restate.handler",
        "restate.idempotency.key",
        "restate.name",
        "restate.object.key",
        "restate.outcome",
        "restate.service",
        "restate.step",
        "restate.workflow.id",
        "semaphore.key",
        "semaphore.target_holder_id",
    ];
}

/// Span names.
pub mod span {
    pub const ACME_OPERATION: &str = "acme.operation";
    pub const ATOMICWRITEFILE: &str = "atomicWriteFile";
    pub const CI_TOOLS_DEPLOY: &str = "ci-tools.deploy";
    pub const CI_TOOLS_DEPLOY_ATTEMPT: &str = "ci-tools.deploy.attempt";
    pub const CI_TOOLS_DEPLOY_CLEANUP: &str = "ci-tools.deploy.cleanup";
    pub const CI_TOOLS_DEPLOY_PROVIDER: &str = "ci-tools.deploy.provider";
    pub const CI_TOOLS_DEPLOY_VERIFY: &str = "ci-tools.deploy.verify";
    pub const CMD_COLLECT: &str = "cmd.collect";
    pub const CMD_RUN: &str = "cmd.run";
    pub const CMD_RUN_WITH_LOGGING: &str = "cmd.run-with-logging";
    pub const FILESYSTEMBACKING_SEMAPHORE_FORCEREVOKE: &str = "FileSystemBacking.semaphore.forceRevoke";
    pub const FILESYSTEMBACKING_SEMAPHORE_KEY: &str = "FileSystemBacking.semaphore.key";
    pub const GENIE_COMMAND: &str = "genie/command";
    pub const GENIE_FILE: &str = "genie/file";
    pub const GENIE_OXFMT: &str = "genie/oxfmt";
    pub const GENIE_PATH: &str = "genie/path";
    pub const GENIE_RUNVALIDATION: &str = "genie/runValidation";
    pub const GENIE_TARGET_LOCK: &str = "genie/target-lock";
    pub const GIT_DELETE_BRANCH: &str = "git/delete-branch";
    pub const GIT_DETACH_WORKTREE_HEAD: &str = "git/detach-worktree-head";
    pub const MEGAREPO_STORE_GC: &str = "megarepo/store/gc";
    pub const MEGAREPO_STORE_GC_ARCHIVE_WORKTREE: &str = "megarepo/store/gc/archive-worktree";
    pub const MEGAREPO_STORE_GC_ASSESS_LOSSLESS: &str = "megarepo/store/gc/assess-lossless";
    pub const MEGAREPO_STORE_GC_COLD_RECLAIM_REPO: &str = "megarepo/store/gc/cold-reclaim-repo";
    pub const MEGAREPO_STORE_GC_REAP_ARCHIVE: &str = "megarepo/store/gc/reap-archive";
    pub const MEGAREPO_STORE_GC_RESOLVE_PR_STATE: &str = "megarepo/store/gc/resolve-pr-state";
    pub const MEGAREPO_STORE_GC_SCAN_ARCHIVES: &str = "megarepo/store/gc/scan-archives";
    pub const MEGAREPO_STORE_GC_UNPUSHED_COMMIT_COUNT: &str = "megarepo/store/gc/unpushed-commit-count";
    pub const MEGAREPO_SYNC: &str = "megarepo/sync";
    pub const MEGAREPO_SYNC_MEMBER: &str = "megarepo/sync/member";
    pub const MEGAREPO_SYNC_MEMBER_CLONE_OR_FETCH: &str = "megarepo/sync/member/clone-or-fetch";
    pub const MEGAREPO_SYNC_MEMBER_CREATE_WORKTREE: &str = "megarepo/sync/member/create-worktree";
    pub const MEGAREPO_SYNC_MEMBER_RESOLVE_REF: &str = "megarepo/sync/member/resolve-ref";
    pub const MEGAREPO_TEST_STORE_FIXTURE_CREATE: &str = "megarepo/test/store-fixture/create";
    pub const MEGAREPO_TEST_STORE_FIXTURE_REPO: &str = "megarepo/test/store-fixture/repo";
    pub const MEGAREPO_TRAVERSAL: &str = "megarepo/traversal";
    pub const NOTION_MD_BATCH_WATCH: &str = "notion-md.batch-watch";
    pub const NOTION_MD_CAT: &str = "notion-md.cat";
    pub const NOTION_MD_COMMENT_BOUNDARY: &str = "notion-md.comment-boundary";
    pub const NOTION_MD_DESTRUCTIVE_BODY: &str = "notion-md.destructive-body";
    pub const NOTION_MD_EDIT: &str = "notion-md.edit";
    pub const NOTION_MD_ESTABLISH_SIDECAR: &str = "notion-md.establish-sidecar";
    pub const NOTION_MD_GATEWAY_ARCHIVE_PAGE: &str = "notion-md.gateway.archive-page";
    pub const NOTION_MD_GATEWAY_CREATE_PAGE: &str = "notion-md.gateway.create-page";
    pub const NOTION_MD_GATEWAY_LIST_CHILD_PAGES: &str = "notion-md.gateway.list-child-pages";
    pub const NOTION_MD_GATEWAY_MOVE_PAGE: &str = "notion-md.gateway.move-page";
    pub const NOTION_MD_GATEWAY_PULL_PAGE: &str = "notion-md.gateway.pull-page";
    pub const NOTION_MD_GATEWAY_RETRIEVE_DATA_SOURCE: &str = "notion-md.gateway.retrieve-data-source";
    pub const NOTION_MD_GATEWAY_UPDATE_MARKDOWN: &str = "notion-md.gateway.update-markdown";
    pub const NOTION_MD_GATEWAY_UPDATE_PAGE_METADATA: &str = "notion-md.gateway.update-page-metadata";
    pub const NOTION_MD_GATEWAY_UPDATE_PAGE_PROPERTIES: &str = "notion-md.gateway.update-page-properties";
    pub const NOTION_MD_MEDIA_BOUNDARY: &str = "notion-md.media-boundary";
    pub const NOTION_MD_OBJECT_GC: &str = "notion-md.object-gc";
    pub const NOTION_MD_PLAN_PATH: &str = "notion-md.plan-path";
    pub const NOTION_MD_PULL_PAGE: &str = "notion-md.pull-page";
    pub const NOTION_MD_PUSH_PAGE: &str = "notion-md.push-page";
    pub const NOTION_MD_PUT: &str = "notion-md.put";
    pub const NOTION_MD_STATE_READ_NMD: &str = "notion-md.state.read-nmd";
    pub const NOTION_MD_STATE_READ_OBJECT: &str = "notion-md.state.read-object";
    pub const NOTION_MD_STATE_WRITE_OBJECT: &str = "notion-md.state.write-object";
    pub const NOTION_MD_STATUS_PAGE: &str = "notion-md.status-page";
    pub const NOTION_MD_STATUS_PATH: &str = "notion-md.status-path";
    pub const NOTION_MD_SYNC_PAGE: &str = "notion-md.sync-page";
    pub const NOTION_MD_SYNC_PATH: &str = "notion-md.sync-path";
    pub const NOTION_MD_SYNC_TREE: &str = "notion-md.sync-tree";
    pub const NOTION_MD_TRACK_PAGE: &str = "notion-md.track-page";
    pub const NOTION_MD_WATCH: &str = "notion-md.watch";
    pub const NOTION_MD_WATCH_SYNC_PASS: &str = "notion-md.watch.sync-pass";
    pub const NOTION_MD_WEBHOOK_TRIGGER: &str = "notion-md.webhook.trigger";
    pub const NOTIONDATABASES_QUERY: &str = "NotionDatabases.query";
    pub const NOTIONPAGES_RETRIEVE: &str = "NotionPages.retrieve";
    pub const PTY_SESSION_MAKE: &str = "pty-session.make";
    pub const PW_WAIT_UNTIL: &str = "pw.wait.until";
    pub const SPAN_ACME_PROBE: &str = "span.acme.probe";
    pub const SPAN_NOTION_REACT_SYNC: &str = "span.notion-react.sync";

    pub const ALL: &[&str] = &[
        "acme.operation",
        "atomicWriteFile",
        "ci-tools.deploy",
        "ci-tools.deploy.attempt",
        "ci-tools.deploy.cleanup",
        "ci-tools.deploy.provider",
        "ci-tools.deploy.verify",
        "cmd.collect",
        "cmd.run",
        "cmd.run-with-logging",
        "FileSystemBacking.semaphore.forceRevoke",
        "FileSystemBacking.semaphore.key",
        "genie/command",
        "genie/file",
        "genie/oxfmt",
        "genie/path",
        "genie/runValidation",
        "genie/target-lock",
        "git/delete-branch",
        "git/detach-worktree-head",
        "megarepo/store/gc",
        "megarepo/store/gc/archive-worktree",
        "megarepo/store/gc/assess-lossless",
        "megarepo/store/gc/cold-reclaim-repo",
        "megarepo/store/gc/reap-archive",
        "megarepo/store/gc/resolve-pr-state",
        "megarepo/store/gc/scan-archives",
        "megarepo/store/gc/unpushed-commit-count",
        "megarepo/sync",
        "megarepo/sync/member",
        "megarepo/sync/member/clone-or-fetch",
        "megarepo/sync/member/create-worktree",
        "megarepo/sync/member/resolve-ref",
        "megarepo/test/store-fixture/create",
        "megarepo/test/store-fixture/repo",
        "megarepo/traversal",
        "notion-md.batch-watch",
        "notion-md.cat",
        "notion-md.comment-boundary",
        "notion-md.destructive-body",
        "notion-md.edit",
        "notion-md.establish-sidecar",
        "notion-md.gateway.archive-page",
        "notion-md.gateway.create-page",
        "notion-md.gateway.list-child-pages",
        "notion-md.gateway.move-page",
        "notion-md.gateway.pull-page",
        "notion-md.gateway.retrieve-data-source",
        "notion-md.gateway.update-markdown",
        "notion-md.gateway.update-page-metadata",
        "notion-md.gateway.update-page-properties",
        "notion-md.media-boundary",
        "notion-md.object-gc",
        "notion-md.plan-path",
        "notion-md.pull-page",
        "notion-md.push-page",
        "notion-md.put",
        "notion-md.state.read-nmd",
        "notion-md.state.read-object",
        "notion-md.state.write-object",
        "notion-md.status-page",
        "notion-md.status-path",
        "notion-md.sync-page",
        "notion-md.sync-path",
        "notion-md.sync-tree",
        "notion-md.track-page",
        "notion-md.watch",
        "notion-md.watch.sync-pass",
        "notion-md.webhook.trigger",
        "NotionDatabases.query",
        "NotionPages.retrieve",
        "pty-session.make",
        "pw.wait.until",
        "span.acme.probe",
        "span.notion-react.sync",
    ];
}

/// Metric names.
pub mod metric {
    pub const ACME_PROBE_DURATION: &str = "acme.probe.duration";
    pub const ACME_PROBES: &str = "acme.probes";
    pub const MEGAREPO_STORE_GC_RSS_BYTES: &str = "megarepo_store_gc_rss_bytes";
    pub const RESTATE_ATTEMPTS_TOTAL: &str = "restate_attempts_total";
    pub const RESTATE_AWAKEABLE_WAIT_MS: &str = "restate_awakeable_wait_ms";
    pub const RESTATE_DURABLE_STEPS_TOTAL: &str = "restate_durable_steps_total";
    pub const RESTATE_INVOCATION_DURATION_MS: &str = "restate_invocation_duration_ms";
    pub const RESTATE_INVOCATIONS_TOTAL: &str = "restate_invocations_total";
    pub const RESTATE_POLL_LOOP_CYCLES_TOTAL: &str = "restate_poll_loop_cycles_total";

    pub const ALL: &[&str] = &[
        "acme.probe.duration",
        "acme.probes",
        "megarepo_store_gc_rss_bytes",
        "restate_attempts_total",
        "restate_awakeable_wait_ms",
        "restate_durable_steps_total",
        "restate_invocation_duration_ms",
        "restate_invocations_total",
        "restate_poll_loop_cycles_total",
    ];
}
