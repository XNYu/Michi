-- Persists the active search integration separately from the model provider.
-- Empty string means disabled; API keys remain in the encrypted
-- user_provider_keys vault under the web-search:<provider> namespace.
ALTER TABLE user_agent_configs ADD COLUMN web_search_provider TEXT NOT NULL DEFAULT '';
