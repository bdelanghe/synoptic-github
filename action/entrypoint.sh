#!/bin/bash
set -e

# Fetch the list of repositories using GitHub API
REPOS=$(curl -s -H "Authorization: token $INPUT_GITHUB_TOKEN" \
            "https://api.github.com/users/$GITHUB_ACTOR/repos?sort=updated&direction=desc" | \
            jq -r '.[] | "- [\(.name)](\(.html_url))"')

# Replace the content between <!-- PROJECTS_START --> and <!-- PROJECTS_END --> in README.md
sed -i '/<!-- PROJECTS_START -->/,/<!-- PROJECTS_END -->/c\<!-- PROJECTS_START -->\n'$REPOS'\n<!-- PROJECTS_END -->' README.md

# Commit and push changes
git config --local user.email "action@github.com"
git config --local user.name "GitHub Action"
git add README.md
if ! git diff --staged --quiet; then
  git commit -m "Update README with latest list of repositories"
  git push
fi
