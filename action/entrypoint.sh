#!/bin/sh
set -e

# Default settings (all fields on by default)
SHOW_STARS=${SHOW_STARS:-true}
SHOW_FORKS=${SHOW_FORKS:-true}
SHOW_ISSUES=${SHOW_ISSUES:-true}
SHOW_LANGUAGE=${SHOW_LANGUAGE:-true}
SHOW_TOPICS=${SHOW_TOPICS:-true}
SHOW_DESCRIPTION=${SHOW_DESCRIPTION:-true}

# Check if gh is installed
if ! command -v gh > /dev/null; then
    echo "Error: GitHub CLI (gh) is not installed!"
    exit 1
fi

# Check authentication status with GitHub CLI
if ! gh auth status >/dev/null; then
    echo "Not authenticated with GitHub CLI."
    
    # Check if GITHUB_TOKEN is provided for authentication
    if [ -z "$GITHUB_TOKEN" ]; then
        echo "Error: GITHUB_TOKEN is not set. Please provide a token for authentication."
        exit 1
    fi
    
    # Authenticate with gh using the provided token
    echo "Logging in with provided GITHUB_TOKEN..."
    echo "$GITHUB_TOKEN" | gh auth login --with-token
fi

# Use the gh CLI to fetch the list of public repositories, sorted by last updated
if ! RESPONSE=$(gh api "user/repos?visibility=public&sort=updated&direction=desc&per_page=100"); then
    echo "Error: Failed to fetch repositories. Please check your authentication or other settings."
    exit 1
fi

# Parse language emojis if SHOW_LANGUAGE is set to true
LANG_EMOJIS_STR=""
if [ "$SHOW_LANGUAGE" = "true" ]; then
    while IFS=":" read -r language emoji; do
        if [ -z "$LANG_EMOJIS_STR" ]; then
            LANG_EMOJIS_STR="\"$language\":\"$emoji\""
        else
            LANG_EMOJIS_STR="$LANG_EMOJIS_STR,\"$language\":\"$emoji\""
        fi
    done < action/language_emojis.txt
    LANG_EMOJIS_JSON="{$LANG_EMOJIS_STR}"
else
    LANG_EMOJIS_JSON="{}"
fi

# Use jq to parse and format the list of repositories with conditional fields
REPOS=$(echo "$RESPONSE" | jq --argjson lang_emojis "$LANG_EMOJIS_JSON" --arg show_stars "$SHOW_STARS" --arg show_forks "$SHOW_FORKS" --arg show_issues "$SHOW_ISSUES" --arg show_language "$SHOW_LANGUAGE" --arg show_topics "$SHOW_TOPICS" --arg show_description "$SHOW_DESCRIPTION" -r '
  .[] | 
  "- [\(.name)](\(.html_url))" + 
  (if $show_description == "true" and .description and .description != "No description provided" then " - \(.description)" else "" end) +
  (if $show_stars == "true" then " (⭐ \(.stargazers_count)" else "" end) +
  (if $show_forks == "true" then " | 🍴 \(.forks_count)" else "" end) +
  (if $show_issues == "true" then " | ❗ \(.open_issues_count))" else (if $show_stars == "true" or $show_forks == "true" then ")" else "" end) end) +
  (if $show_language == "true" and .language then " - " + ($lang_emojis[.language] // "📜") + " Written in \(.language)" else "" end) +
  (if $show_topics == "true" and (.topics | length) > 0 then " - Topics: \(.topics | join(", "))" else "" end) +
  "\n"')

# Output to the README.md file
printf "# My Repositories\n\n" > README.md
printf "%s" "$REPOS" >> README.md
printf "\n" >> README.md
