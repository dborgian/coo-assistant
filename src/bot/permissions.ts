import type { AccessRole } from "./auth-types.js";

/** Which roles can use each AI agent tool */
export const TOOL_PERMISSIONS: Record<string, AccessRole[]> = {
  // READ-SAFE: all authenticated users
  get_calendar_events: ["owner", "admin", "viewer"],
  get_team_workload: ["owner", "admin", "viewer"],
  get_team_capacity: ["owner", "admin", "viewer"],
  get_project_eta: ["owner", "admin", "viewer"],
  suggest_assignment: ["owner", "admin", "viewer"],
  get_meeting_intelligence: ["owner", "admin", "viewer"],

  // READ (admin+): access broader data
  search_drive: ["owner", "admin"],
  get_report_history: ["owner", "admin"],
  get_slack_summary: ["owner", "admin"],

  // WRITE: modify system state
  create_task: ["owner", "admin"],
  update_task_status: ["owner", "admin"],
  edit_task: ["owner", "admin"],
  delete_tasks: ["owner", "admin"],
  get_task_history: ["owner", "admin"],
  create_recurring_task: ["owner", "admin"],
  set_task_dependency: ["owner", "admin"],
  snooze_escalation: ["owner", "admin"],
  schedule_task: ["owner", "admin"],
  send_slack_notification: ["owner", "admin"],
  send_email: ["owner", "admin"],
  add_notion_comment: ["owner", "admin"],
  notion_action: ["owner", "admin"],
  create_notion_project: ["owner", "admin"],
  generate_report_pdf: ["owner", "admin"],

  // CALENDAR MANAGEMENT: modify calendar
  delete_calendar_event: ["owner", "admin"],
  unschedule_task: ["owner", "admin"],

  // GOOGLE DOCS + SEARCH
  create_google_doc: ["owner", "admin"],
  unified_search: ["owner", "admin"],

  // EMAIL: forward, reply, search
  forward_email: ["owner", "admin"],
  reply_email: ["owner", "admin"],
  search_emails: ["owner", "admin"],

  // SLACK: search messages + thread replies
  search_slack_message: ["owner", "admin"],

  // SENSITIVE: strategic analytics (owner only)
  get_team_sentiment: ["owner"],
  get_communication_patterns: ["owner"],
  get_commitments: ["owner"],
  query_knowledge_base: ["owner"],
  get_topics: ["owner"],
  create_project_from_description: ["owner"],

  // CONFIG: team management (owner only)
  manage_team: ["owner"],

  // COMPANY BRAIN + MEETING NOTES (owner/admin)
  query_brain: ["owner", "admin"],
  add_brain_fact: ["owner", "admin"],
  resolve_decision: ["owner"],
  brain_status: ["owner", "admin"],
  process_meeting_notes: ["owner", "admin"],

  // SCREENSHOT
  take_screenshot: ["owner", "admin"],
  get_browser_login_instructions: ["owner", "admin"],

  // VISIBILITY + CONTROL (Phase 2B/2C)
  get_health_score: ["owner", "admin"],
  get_recap: ["owner", "admin"],
  manage_notifications: ["owner", "admin", "viewer"],
  get_team_overview: ["owner", "admin"],
  get_audit_log: ["owner", "admin"],
};

/** Get list of tool names allowed for a given role */
export function getAllowedToolNames(role: AccessRole): Set<string> {
  const allowed = new Set<string>();
  for (const [tool, roles] of Object.entries(TOOL_PERMISSIONS)) {
    if (roles.includes(role)) allowed.add(tool);
  }
  return allowed;
}

/** Which dashboard callback sections each role can see */
export const DASHBOARD_SECTIONS: Record<string, AccessRole[]> = {
  "dash:tasks": ["owner", "admin", "viewer"],
  "dash:calendar": ["owner", "admin", "viewer"],
  "dash:slack": ["owner", "admin"],
  "dash:email": ["owner", "admin"],
  "dash:notion": ["owner", "admin"],
  "dash:drive": ["owner", "admin"],
  "dash:report": ["owner", "admin"],
  "dash:history": ["owner", "admin"],
};

/** Check if a role can access a dashboard section */
export function canAccessSection(section: string, role: AccessRole): boolean {
  return DASHBOARD_SECTIONS[section]?.includes(role) ?? false;
}
