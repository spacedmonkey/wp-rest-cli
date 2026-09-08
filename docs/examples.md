# Examples

```sh
# Discover a site
wp-rest-cli --url=https://example.com

# List routes in a namespace
wp-rest-cli wp/v2 --url=https://example.com

# Introspect a route (methods, args, supported --context values)
wp-rest-cli wp/v2 posts --url=https://example.com

# List, with query args and JSON output
wp-rest-cli wp/v2 posts list --per_page=5 --format=json --url=https://example.com

# Get one, as edit context, authenticated
wp-rest-cli wp/v2 posts get 42 --context=edit --url=https://example.com --username=admin --password=xxxx-xxxx-xxxx-xxxx

# Create
wp-rest-cli wp/v2 posts create --title="Hello" --status=publish --url=https://example.com

# Update
wp-rest-cli wp/v2 posts update 42 --status=draft --url=https://example.com

# Delete
wp-rest-cli wp/v2 posts delete 42 --force --url=https://example.com

# Check whether an item exists (exit code 0/1, no output payload needed)
wp-rest-cli wp/v2 posts exists 42 --url=https://example.com

# Generate 5 posts reusing the same fields
wp-rest-cli wp/v2 posts generate --count=5 --status=publish --url=https://example.com

# Save defaults so you don't have to repeat --url/--username
wp-rest-cli config set --url=https://example.com --username=admin
wp-rest-cli config get
wp-rest-cli config clear
```

## Meta

```sh
# List every meta key visible on post 42
wp-rest-cli wp/v2 posts meta list 42 --url=https://example.com

# Read one meta key
wp-rest-cli wp/v2 posts meta get 42 my_key --url=https://example.com

# Set a meta value
wp-rest-cli wp/v2 posts meta update 42 my_key "some value" --url=https://example.com

# Delete a whole meta key
wp-rest-cli wp/v2 posts meta delete 42 my_key --url=https://example.com

# Read/write a nested value inside a structured meta field
wp-rest-cli wp/v2 posts meta pluck 42 my_settings some.nested.path --url=https://example.com
wp-rest-cli wp/v2 posts meta patch 42 update my_settings some.nested.path "new value" --url=https://example.com
```

See [Meta commands](meta-commands.md) for the full set.
