# Design

The main process persists pending messages in each thread timeline. Queue drains sequentially after successful runs; cancellation and failure pause it. Restart restores pending input for explicit sending. Steer inserts user input at the next model boundary, after outstanding tool results, preserving tool-call pairing and session history. Pending messages can be removed or promoted to Steer. The composer and Appearance settings share a persisted follow-up default.

Reference: https://developers.openai.com/blog/mastering-codex-remote-for-engineering
Internal context: https://bytedance.larkoffice.com/docx/YEaudOcpGobaoZxXLyactUWJnee
