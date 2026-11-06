// Gots dashboard tab. Hand-written against window.__HERMES_PLUGIN_SDK__, so there's no build step.
;(function () {
  "use strict"

  var SDK = window.__HERMES_PLUGIN_SDK__
  var React = SDK.React
  var h = React.createElement
  var useEffect = SDK.hooks.useEffect
  var useState = SDK.hooks.useState
  var C = SDK.components

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s")
  }

  function Row(props) {
    return h(
      "div",
      { className: "flex items-center justify-between gap-4 py-2 text-sm" },
      h("span", { className: "text-muted-foreground" }, props.label),
      h("span", { className: "text-right font-medium" }, props.children),
    )
  }

  function EnabledBadge(props) {
    if (props.enabled === null || props.enabled === undefined) return h(C.Badge, null, "Unknown")
    return props.enabled
      ? h(C.Badge, null, "Enabled")
      : h(C.Badge, { variant: "destructive" }, "Not enabled")
  }

  function message(reason) {
    return String((reason && reason.message) || reason)
  }

  function post(path, body) {
    return SDK.fetchJSON("/api/plugins/gots/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    })
  }

  function Field(props) {
    return h(
      "div",
      { className: "flex flex-col gap-1.5" },
      h(C.Label, { htmlFor: props.id }, props.label),
      h(C.Input, {
        id: props.id,
        value: props.value,
        placeholder: props.placeholder,
        spellCheck: false,
        autoComplete: "off",
        onChange: function (event) {
          props.onChange(event.target.value)
        },
      }),
    )
  }

  // Links this profile to a Gots account with a code from the app, like `hermes gots link`.
  function LinkCard() {
    var linkState = useState(null)
    var link = linkState[0]
    var setLink = linkState[1]
    var codeState = useState("")
    var siteState = useState("")
    var urlState = useState("")
    var busyState = useState(false)
    var errorState = useState(null)
    var noteState = useState(null)

    function load(value) {
      setLink(value)
      siteState[1](value.site || siteState[0])
      urlState[1](value.url || urlState[0])
      if ("warning" in value) noteState[1](value.warning || null)
    }

    useEffect(function () {
      SDK.fetchJSON("/api/plugins/gots/link")
        .then(load)
        .catch(function (reason) {
          errorState[1](message(reason))
        })
    }, [])

    function run(promise) {
      busyState[1](true)
      errorState[1](null)
      promise
        .then(load)
        .catch(function (reason) {
          errorState[1](message(reason))
        })
        .finally(function () {
          busyState[1](false)
        })
    }

    var body
    if (!link) {
      body = h("p", { className: "text-sm text-muted-foreground" }, errorState[0] || "Loading…")
    } else if (link.linked) {
      // Hermes's install scan reads `env` then a pipe as dumping the environment, so no `||` here.
      var env = link.env ? Object.keys(link.env) : []
      body = h(
        "div",
        { className: "flex flex-col" },
        h(Row, { label: "Bot" }, link.name || link.profile),
        h(C.Separator, null),
        h(Row, { label: "Gots" }, link.site),
        h(C.Separator, null),
        h(Row, { label: "API server URL" }, link.url),
        env.length > 0 &&
          h(
            "div",
            { className: "flex flex-col gap-2 pt-3 text-sm" },
            h("p", null, "Gots needs these lines in this profile's .env:"),
            h(
              "pre",
              { className: "rounded bg-muted p-2 font-mono text-xs" },
              env
                .map(function (key) {
                  return key + "=" + link.env[key]
                })
                .join("\n"),
            ),
            h(
              C.Button,
              {
                disabled: busyState[0],
                onClick: function () {
                  run(post("link/env"))
                  noteState[1]("Restart the gateway to apply them: hermes gateway restart")
                },
              },
              "Add them",
            ),
          ),
        h(
          "div",
          { className: "pt-3" },
          h(
            C.Button,
            {
              variant: "outline",
              disabled: busyState[0],
              onClick: function () {
                run(post("unlink"))
              },
            },
            "Unlink",
          ),
        ),
      )
    } else {
      body = h(
        "form",
        {
          className: "flex flex-col gap-3",
          onSubmit: function (event) {
            event.preventDefault()
            run(post("link", { code: codeState[0].trim(), site: siteState[0], url: urlState[0] }))
          },
        },
        link.revoked &&
          h("p", { className: "text-sm text-muted-foreground" }, "Removed in Gots. Link it again with a new code."),
        h(Field, {
          id: "gots-code",
          label: "Link code",
          placeholder: "mk_…",
          value: codeState[0],
          onChange: codeState[1],
        }),
        h(Field, {
          id: "gots-site",
          label: "Gots address",
          placeholder: "https://…",
          value: siteState[0],
          onChange: siteState[1],
        }),
        h(Field, {
          id: "gots-url",
          label: "API server URL your phone reaches",
          value: urlState[0],
          onChange: urlState[1],
        }),
        h(
          "div",
          null,
          h(
            C.Button,
            { type: "submit", disabled: busyState[0] || !codeState[0].trim() || !siteState[0] },
            "Link",
          ),
        ),
      )
    }

    return h(
      C.Card,
      null,
      h(C.CardHeader, null, h(C.CardTitle, null, "Link to Gots")),
      h(
        C.CardContent,
        { className: "flex flex-col gap-3" },
        body,
        link && errorState[0] && h("p", { className: "text-sm text-destructive" }, errorState[0]),
        noteState[0] && h("p", { className: "text-sm text-muted-foreground" }, noteState[0]),
      ),
    )
  }

  function GotsPage() {
    var state = useState(null)
    var status = state[0]
    var setStatus = state[1]
    var errorState = useState(null)
    var error = errorState[0]
    var setError = errorState[1]

    useEffect(function () {
      SDK.fetchJSON("/api/plugins/gots/status")
        .then(setStatus)
        .catch(function (reason) {
          setError(String((reason && reason.message) || reason))
        })
    }, [])

    var body
    if (error) {
      body = h("p", { className: "text-sm text-destructive" }, error)
    } else if (!status) {
      body = h("p", { className: "text-sm text-muted-foreground" }, "Loading…")
    } else {
      var ledger = status.ledger || {}
      var chats = status.chats || {}
      body = h(
        "div",
        { className: "flex flex-col" },
        h(Row, { label: "Version" }, status.version),
        h(C.Separator, null),
        h(Row, { label: "Plugin" }, h(EnabledBadge, { enabled: status.enabled })),
        h(C.Separator, null),
        h(
          Row,
          { label: "Run history" },
          ledger.exists
            ? plural(ledger.runs, "run") + " across " + plural(ledger.jobs, "routine")
            : "No runs recorded yet",
        ),
        h(C.Separator, null),
        h(Row, { label: "Chats" }, chats.exists ? plural(chats.chats, "chat") : "No chats stored yet"),
        h(C.Separator, null),
        h(
          Row,
          { label: "API server routes" },
          h(
            "span",
            { className: "flex flex-col items-end font-mono text-xs" },
            (status.routes || []).map(function (route) {
              return h("span", { key: route }, route)
            }),
          ),
        ),
        status.enabled === false &&
          h(
            "p",
            { className: "pt-3 text-sm text-muted-foreground" },
            "Run ",
            h("code", null, "hermes plugins enable gots"),
            ", then ",
            h("code", null, "hermes gateway restart"),
            ".",
          ),
      )
    }

    return h(
      "div",
      { className: "flex flex-col gap-4" },
      h(LinkCard, null),
      h(
        C.Card,
        null,
        h(C.CardHeader, null, h(C.CardTitle, null, "Gots")),
        h(C.CardContent, null, body),
      ),
    )
  }

  window.__HERMES_PLUGINS__.register("gots", GotsPage)
})()
