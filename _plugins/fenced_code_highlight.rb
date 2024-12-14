# This custom plugin for Jekyll modifies the default behavior of kramdown to ensure that
# fenced code blocks generate the same HTML structure as the {% highlight %} tags.
# It achieves this by extending the Kramdown::Converter::Html class to customize the
# HTML output for code blocks and integrating this custom converter into Jekyll's
# Markdown conversion process.

require 'rouge'

module Jekyll
  module Converters
    class Markdown < Converter
      safe true
      priority :low

      def setup
        return if @setup
        @setup = true
        @config = @config['kramdown'] || {}
      end

      def convert(content)
        setup
        Kramdown::Document.new(content, @config).to_html
      end
    end
  end
end

module Kramdown
  module Converter
    class Html < Base
      def convert_codeblock(el, indent)
        attr = el.attr.dup
        lang = extract_code_language!(attr)
        code = el.value
        formatter = Rouge::Formatters::HTML.new
        lexer = Rouge::Lexer.find_fancy(lang, code) || Rouge::Lexers::PlainText
        highlighted_code = formatter.format(lexer.lex(code))
        <<~HTML
          <figure class="highlight">
            <pre>
              <code class="language-#{lang}" data-lang="#{lang}">#{highlighted_code}</code>
            </pre>
          </figure>
        HTML
      end
    end
  end
end