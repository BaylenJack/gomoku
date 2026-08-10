#!/bin/bash
cd /opt/gomoku
GIT_SAFE="git -c safe.directory=/opt/gomoku"
$GIT_SAFE fetch origin master 2>&1
LOCAL=$($GIT_SAFE rev-parse HEAD)
REMOTE=$($GIT_SAFE rev-parse origin/master)
if [ "$LOCAL" != "$REMOTE" ]; then
  $GIT_SAFE reset --hard origin/master
  sudo systemctl restart gomoku
  echo "updated: $(echo $LOCAL | cut -c1-8) -> $(echo $REMOTE | cut -c1-8)"
else
  echo "no update"
fi
