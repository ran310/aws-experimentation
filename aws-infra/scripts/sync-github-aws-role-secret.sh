#!/usr/bin/env bash
#
# Set the same GitHub Actions secret (default: AWS_ROLE_TO_ASSUME) on many repositories
# using the GitHub CLI — no copy/paste per repo in the web UI.
#
# Prerequisites:
#   - gh  (https://cli.github.com/) — authenticated: gh auth login
#   - For --from-stack: AWS CLI credentials (same account/region as the stack)
#
# Usage (repository secrets — full owner/repo):
#   export AWS_ROLE_TO_ASSUME_ARN='arn:aws:iam::123456789012:role/learn-aws-github-actions'
#   ./sync-github-aws-role-secret.sh ran310/nfl-quiz ran310/aws-health-dashboard
#
#   ./sync-github-aws-role-secret.sh --from-stack AwsInfra-GitHubOidc \
#     --file ~/code/github/deploy-repos.txt
#
# Personal GitHub user (e.g. ran310 — not an organization):
#   Run: gh auth login  # as that user, so private repos are included
#   ./sync-github-aws-role-secret.sh --owner ran310 --from-stack AwsInfra-GitHubOidc
#   ./sync-github-aws-role-secret.sh --owner ran310 --dry-run   # list only
#   Discovery uses GET /user/repos?type=owner when your gh login matches --owner.
#
# Discover repos under a GitHub Organization (company org, not a user account):
#   ./sync-github-aws-role-secret.sh --owner my-company --from-stack ...
#
# Organization-level secret (single secret shared by named repos under an ORG — not for personal users):
#   ./sync-github-aws-role-secret.sh --org my-company --repos app1,app2 --from-stack ...
#
# Files: one repository per line; # starts a comment; blank lines ignored.
#   - Without --org: each line must be OWNER/REPO
#   - With --org: each line is REPO (same org as --org)
#
set -euo pipefail

SECRET_NAME='AWS_ROLE_TO_ASSUME'
ARN_VALUE=''
CFN_STACK=''
CFN_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
DISCOVER_OWNER=''
INCLUDE_FORKS='false'
INCLUDE_ARCHIVED='false'
DRY_RUN='false'
ORG=''
REPOS_CSV=''
INPUT_FILE=''
REPOS_FROM_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  sync-github-aws-role-secret.sh [options] [owner/repo ...]

Set the same Actions secret (default: AWS_ROLE_TO_ASSUME) on many GitHub repos via gh.

Options:
  --owner LOGIN           List all repos for LOGIN (GitHub org OR personal user; see Discovery)
  --include-forks         When using --owner, also include fork repositories
  --include-archived      When using --owner, also include archived repositories
  --dry-run               With --owner: print repo names only; do not call gh secret set
  --value ARN             Secret body (IAM role ARN)
  --from-stack NAME       Read output GitHubActionsRoleArn from CloudFormation
  --region REGION         Region for --from-stack (default: AWS_REGION or us-east-1)
  --secret-name NAME      Default: AWS_ROLE_TO_ASSUME
  --org ORG               GitHub Organization only: one org-level secret; repo names are short (no user accounts)
  --repos LIST            Comma-separated repos with --org (e.g. a,b,c)
  --file PATH             Newline-separated repo list (see script header)
  -h, --help              Show this help

Environment:
  AWS_ROLE_TO_ASSUME_ARN  Used as the secret value if --value / --from-stack omitted

Discovery (--owner):
  - Personal user: if LOGIN matches `gh api user` (same account you ran gh auth login with),
    uses /user/repos?type=owner — all repos you own, including private.
  - Organization: if /orgs/LOGIN exists, uses /orgs/LOGIN/repos — all repos you can see.
  - Any other LOGIN: public repos only via /users/LOGIN/repos (GitHub API limitation).

  Forks and archived repos are skipped unless --include-forks / --include-archived.

Examples (personal user ran310):
  gh auth login   # as ran310
  ./sync-github-aws-role-secret.sh --from-stack AwsInfra-GitHubOidc --owner ran310

Examples (GitHub Organization):
  ./sync-github-aws-role-secret.sh --org acme-corp --repos app1,app2 \\
    --value "$AWS_ROLE_TO_ASSUME_ARN"
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  }
}

resolve_arn() {
  if [[ -n "$ARN_VALUE" ]]; then
    printf '%s' "$ARN_VALUE"
    return
  fi
  if [[ -n "${AWS_ROLE_TO_ASSUME_ARN:-}" ]]; then
    printf '%s' "${AWS_ROLE_TO_ASSUME_ARN}"
    return
  fi
  if [[ -n "$CFN_STACK" ]]; then
    require_cmd aws
    local out
    out="$(aws cloudformation describe-stacks \
      --stack-name "$CFN_STACK" \
      --region "$CFN_REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='GitHubActionsRoleArn'].OutputValue" \
      --output text 2>/dev/null || true)"
    if [[ -z "$out" || "$out" == "None" ]]; then
      echo "ERROR: Stack ${CFN_STACK} has no output GitHubActionsRoleArn in ${CFN_REGION}" >&2
      exit 1
    fi
    printf '%s' "$out"
    return
  fi
  echo 'ERROR: Provide --value, export AWS_ROLE_TO_ASSUME_ARN, or --from-stack' >&2
  exit 1
}

read_repo_file_lines() {
  local file="$1"
  [[ -f "$file" ]] || {
    echo "ERROR: Not a file: $file" >&2
    exit 1
  }
  grep -v '^[[:space:]]*#' "$file" | sed '/^[[:space:]]*$/d' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

append_repos_from_file_to_csv() {
  local file="$1"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    if [[ -n "$repos_list" ]]; then repos_list+=','; fi
    repos_list+="$line"
  done < <(read_repo_file_lines "$file")
}

# Prints jq filter for one page array: emit .full_name per repo.
discover_jq_filter() {
  local fork_cond arc_cond
  fork_cond='true'
  arc_cond='true'
  [[ "$INCLUDE_FORKS" != true ]] && fork_cond='(.fork | not)'
  [[ "$INCLUDE_ARCHIVED" != true ]] && arc_cond='(.archived | not)'
  printf '.[] | select(%s and %s) | .full_name' "$fork_cond" "$arc_cond"
}

# Prints one owner/repo per line to stdout.
discover_repos_for_owner() {
  local owner="$1"
  local jq_filter
  jq_filter="$(discover_jq_filter)"

  if gh api "/orgs/${owner}" &>/dev/null; then
    gh api --paginate "/orgs/${owner}/repos" -q "$jq_filter"
    return
  fi

  local me me_l owner_l
  me="$(gh api user -q .login 2>/dev/null || true)"
  me_l="$(printf '%s' "$me" | tr '[:upper:]' '[:lower:]')"
  owner_l="$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')"
  if [[ -n "$me" && "$me_l" == "$owner_l" ]]; then
    gh api --paginate '/user/repos?type=owner' -q "$jq_filter"
    return
  fi

  echo "WARN: ${owner} is not an org and is not the authenticated user (${me:-unknown}); listing public repos only." >&2
  gh api --paginate "/users/${owner}/repos" -q "$jq_filter"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --owner)
      DISCOVER_OWNER="${2:-}"
      shift 2
      ;;
    --include-forks)
      INCLUDE_FORKS='true'
      shift
      ;;
    --include-archived)
      INCLUDE_ARCHIVED='true'
      shift
      ;;
    --dry-run)
      DRY_RUN='true'
      shift
      ;;
    --value)
      ARN_VALUE="${2:-}"
      shift 2
      ;;
    --from-stack)
      CFN_STACK="${2:-}"
      shift 2
      ;;
    --region)
      CFN_REGION="${2:-}"
      shift 2
      ;;
    --secret-name)
      SECRET_NAME="${2:-}"
      shift 2
      ;;
    --org)
      ORG="${2:-}"
      shift 2
      ;;
    --repos)
      REPOS_CSV="${2:-}"
      shift 2
      ;;
    --file)
      INPUT_FILE="${2:-}"
      shift 2
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      REPOS_FROM_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -n "$DISCOVER_OWNER" && -n "$ORG" ]]; then
  echo 'ERROR: Use either --org (one org secret) or --owner (per-repo secrets), not both.' >&2
  exit 1
fi
if [[ -n "$DISCOVER_OWNER" && -n "$INPUT_FILE" ]]; then
  echo 'ERROR: --owner cannot be combined with --file' >&2
  exit 1
fi
if [[ -n "$DISCOVER_OWNER" && ${#REPOS_FROM_ARGS[@]} -gt 0 ]]; then
  echo 'ERROR: --owner cannot be combined with positional owner/repo arguments' >&2
  exit 1
fi

require_cmd gh
gh auth status >/dev/null 2>&1 || {
  echo 'ERROR: gh is not authenticated. Run: gh auth login' >&2
  exit 1
}

if [[ "$DRY_RUN" == true && -z "$DISCOVER_OWNER" ]]; then
  echo 'ERROR: --dry-run is only supported with --owner' >&2
  exit 1
fi

ARN=''
if [[ "$DRY_RUN" != true ]]; then
  ARN="$(resolve_arn)"
  if [[ ! "$ARN" =~ ^arn:aws:iam::[0-9]{12}:role/ ]]; then
    echo "WARN: Value does not look like an IAM role ARN (continuing anyway): ${ARN:0:60}..." >&2
  fi
fi

if [[ -n "$ORG" ]]; then
  repos_list="${REPOS_CSV:-}"
  if [[ -n "$INPUT_FILE" ]]; then
    append_repos_from_file_to_csv "$INPUT_FILE"
  fi
  if [[ ${#REPOS_FROM_ARGS[@]} -gt 0 ]]; then
    for r in "${REPOS_FROM_ARGS[@]}"; do
      if [[ -n "$repos_list" ]]; then repos_list+=','; fi
      if [[ "$r" == */* ]]; then
        o="${r%%/*}"
        short="${r#*/}"
        if [[ "$o" != "$ORG" ]]; then
          echo "ERROR: Under --org $ORG, repo must be short name or ${ORG}/REPO — got $r" >&2
          exit 1
        fi
        repos_list+="$short"
      else
        repos_list+="$r"
      fi
    done
  fi
  if [[ -z "$repos_list" ]]; then
    echo 'ERROR: Organization mode needs --repos and/or --file and/or repo arguments' >&2
    exit 1
  fi
  echo "Setting org secret ${SECRET_NAME} on org ${ORG} for repos: ${repos_list}"
  gh secret set "$SECRET_NAME" \
    --org "$ORG" \
    --app actions \
    --visibility selected \
    --repos "$repos_list" \
    --body "$ARN"
  echo 'Done.'
  exit 0
fi

declare -a TARGET_REPOS=()

if [[ -n "$DISCOVER_OWNER" ]]; then
  echo "Discovering repositories for ${DISCOVER_OWNER}..." >&2
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    TARGET_REPOS+=("$line")
  done < <(discover_repos_for_owner "$DISCOVER_OWNER")
  if [[ ${#TARGET_REPOS[@]} -eq 0 ]]; then
    echo "ERROR: No repositories matched (after fork/archived filters). Try --include-forks / --include-archived." >&2
    exit 1
  fi
  echo "Found ${#TARGET_REPOS[@]} repository(ies)." >&2
  if [[ "$DRY_RUN" == true ]]; then
    printf '%s\n' "${TARGET_REPOS[@]}"
    exit 0
  fi
else
  if [[ -n "$INPUT_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      TARGET_REPOS+=("$line")
    done < <(read_repo_file_lines "$INPUT_FILE")
  fi
  TARGET_REPOS+=("${REPOS_FROM_ARGS[@]}")
fi

if [[ ${#TARGET_REPOS[@]} -eq 0 ]]; then
  echo 'ERROR: Pass owner/repo arguments, --file, or --owner LOGIN' >&2
  usage >&2
  exit 1
fi

for repo in "${TARGET_REPOS[@]}"; do
  if [[ "$repo" != */* ]]; then
    echo "ERROR: Expected OWNER/REPO, got: $repo" >&2
    exit 1
  fi
  echo "Setting ${SECRET_NAME} on ${repo}"
  gh secret set "$SECRET_NAME" --repo "$repo" --app actions --body "$ARN"
done

echo 'Done.'
