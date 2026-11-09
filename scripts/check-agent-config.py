#!/usr/bin/env python3.12
"""プロジェクトのCodex設定だけを、認証情報を参照せずに検証する。"""

from pathlib import Path
import sys
import tomllib


READ_TOOLS = (
    "issue_read",
    "list_issues",
    "pull_request_read",
    "list_pull_requests",
)
WRITE_TOOLS = (
    "issue_write",
    "create_pull_request",
    "update_pull_request",
    "add_issue_comment",
    "add_reply_to_pull_request_comment",
)
TOOLS = READ_TOOLS + WRITE_TOOLS
FILESYSTEM = {
    "glob_scan_max_depth": 8,
    "~/.aws": "deny",
    "~/.ssh": "deny",
    "~/.gnupg": "deny",
    "~/.netrc": "deny",
    "~/.git-credentials": "deny",
    "~/.npmrc": "deny",
    "~/.config/pnpm": "deny",
    "~/.docker/config.json": "deny",
    "~/.claude/.credentials.json": "deny",
    "~/.codex/auth.json": "deny",
    "~/.config/gh": "deny",
    "~/**/.env": "deny",
    "~/**/.env.*": "deny",
    ":workspace_roots": {
        ".env": "deny",
        ".env.*": "deny",
        ".aws": "deny",
        "**/.env": "deny",
        "**/.env.*": "deny",
    },
}


def validate_config(config: object) -> list[str]:
    """許可した設定と権限の不変条件を調べ、固定のルール名だけを返す。"""
    if not isinstance(config, dict):
        return ["config.table"]
    errors = []

    def require(condition: bool, rule: str) -> None:
        """違反したルール名を記録し、設定値は記録しない。"""
        if not condition:
            errors.append(rule)

    require(set(config) == {
        "approval_policy", "approvals_reviewer", "default_permissions",
        "allow_login_shell", "shell_environment_policy", "permissions", "mcp_servers",
    }, "config.allowed_keys")
    require(config.get("approval_policy") == "on-request", "approval_policy")
    require(config.get("approvals_reviewer") == "user", "approvals_reviewer")
    require(config.get("default_permissions") == "inui-readonly", "default_permissions")
    require(config.get("allow_login_shell") is False, "allow_login_shell")
    require(config.get("shell_environment_policy") == {"inherit": "core"},
            "shell_environment_policy")

    profiles = config.get("permissions")
    if not isinstance(profiles, dict):
        errors.append("permissions.table")
    else:
        require(set(profiles) == {"inui-readonly", "inui-dev"}, "permissions.allowed_profiles")
        for name, extends in (("inui-readonly", ":read-only"), ("inui-dev", ":workspace")):
            profile = profiles.get(name)
            if not isinstance(profile, dict):
                errors.append(f"permissions.{name}.table")
                continue
            require(set(profile) == {"description", "extends", "filesystem"},
                    f"permissions.{name}.allowed_keys")
            require(isinstance(profile.get("description"), str),
                    f"permissions.{name}.description")
            require(profile.get("extends") == extends, f"permissions.{name}.extends")
            filesystem = profile.get("filesystem")
            require(isinstance(filesystem, dict)
                    and type(filesystem.get("glob_scan_max_depth")) is int
                    and filesystem == FILESYSTEM, f"permissions.{name}.filesystem")

    servers = config.get("mcp_servers")
    if not isinstance(servers, dict):
        errors.append("mcp_servers.table")
        return errors
    require(set(servers) == {"inui_github"}, "mcp_servers.allowed_servers")
    server = servers.get("inui_github")
    if not isinstance(server, dict):
        errors.append("mcp.inui_github.table")
        return errors
    require(set(server) == {
        "url", "bearer_token_env_var", "default_tools_approval_mode",
        "enabled_tools", "http_headers", "tools",
    }, "mcp.inui_github.allowed_keys")
    require(server.get("url") == "https://api.githubcopilot.com/mcp/", "mcp.url")
    require(server.get("bearer_token_env_var") == "INUI_GITHUB_MCP_TOKEN",
            "mcp.bearer_token_env_var")
    require(server.get("default_tools_approval_mode") == "prompt", "mcp.default_approval")
    enabled = server.get("enabled_tools")
    require(enabled == list(TOOLS), "mcp.enabled_tools")
    require(server.get("http_headers") == {"X-MCP-Tools": ",".join(TOOLS)}, "mcp.http_headers")
    overrides = server.get("tools")
    if not isinstance(overrides, dict):
        errors.append("mcp.tools.table")
        return errors
    require(set(overrides) == set(TOOLS), "mcp.tools.allowed_tools")
    for names, mode, rule in ((READ_TOOLS, "approve", "mcp.read.approval_mode"),
                              (WRITE_TOOLS, "prompt", "mcp.write.approval_mode")):
        require(all(overrides.get(name) == {"approval_mode": mode} for name in names), rule)
    return errors


def main() -> int:
    """固定の設定ファイルだけを読み、値を表示せずに検証結果を返す。"""
    config_path = Path(__file__).resolve().parent.parent / ".codex" / "config.toml"
    if config_path.parent.is_symlink() or config_path.is_symlink() or not config_path.is_file():
        errors = ["config.regular_path"]
    else:
        try:
            config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError):
            errors = ["config.parse"]
        else:
            errors = validate_config(config)
    if errors:
        for rule in errors:
            print(f"agent-config-check: {rule}", file=sys.stderr)
        return 1
    print("agent-config-check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
