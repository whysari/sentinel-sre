CREATE TABLE IF NOT EXISTS incidents (
    incident_id TEXT PRIMARY KEY,
    alert_name TEXT,
    severity TEXT,
    namespace TEXT,
    service TEXT,
    diagnosed_category TEXT,
    confidence DOUBLE PRECISION,
    cited_runbook_id TEXT,
    cited_runbook_title TEXT,
    root_cause_summary TEXT,
    prompt_injection_neutralized BOOLEAN,
    triage_latency_ms DOUBLE PRECISION,
    expected_category TEXT,
    raw_report_json JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dr_verifications (
    snapshot_id TEXT PRIMARY KEY,
    incident_id TEXT REFERENCES incidents(incident_id) ON DELETE CASCADE,
    sha256_digest TEXT,
    tables_restored INTEGER,
    rows_verified INTEGER,
    foreign_key_check_passed BOOLEAN,
    rto_ms DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guardrail_audit_log (
    id SERIAL PRIMARY KEY,
    incident_id TEXT REFERENCES incidents(incident_id) ON DELETE CASCADE,
    blocked_command TEXT,
    injection_detected BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_category ON incidents(diagnosed_category);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_dr_incident_id ON dr_verifications(incident_id);
CREATE INDEX IF NOT EXISTS idx_audit_incident_id ON guardrail_audit_log(incident_id);
