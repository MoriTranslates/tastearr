# Security

- **Login flood trade-off (accepted):** while one address floods logins with made-up user names, the account's real user name answers "wrong username or password" (401) where the made-up names get "too many attempts" (429), so that flooder can learn the user name. This keeps a flood from locking the owner out; the password is still required, and guesses at it are throttled on their own.
