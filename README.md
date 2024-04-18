# Personal Website

Based on the [end2end Clean Jekyll theme](https://github.com/nandomoreirame/end2end)

## Branches

- The `main` branch, where the site's development sources are contained.

- The `gh-pages` branch, where the site's generated static files are deployed.

## Usage

When developing:

```bash
bundle install
bundle exec jekyll serve
```

To create a new post:

```bash
rake post title="TITLE OF THE POST"
```

To create a new page:

```bash
rake page name="contact.md"
```

To deploy:

```bash
rake publish
```
