# Review decisions

## RD-20261124-merging-this-pr-alone-breaks-facebook-sc: Merging this PR alone breaks Facebook scraping: nothing in it writes facebook_cookies and FB_COOKIES is no longer read

- **Proposed:** saveFacebookCookies, getFacebookCookieStatus and updateSchedulerSettings have no caller outside tests in this PR, and the env fallback was removed, so merged on its own every Facebook search fails with the login-required error on any machine that has not already synced cookies. The branch is correct only together with PR 2 yet is presented as independently mergeable. The author notes it did not check a machine without the extension.
- **Decision:** Do not make this change.
- **Why:** The server will not be started until the extension branch is merged, so the two ship together
- **Reopen if:** New evidence that the reason above no longer holds.
