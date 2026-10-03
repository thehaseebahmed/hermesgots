// Memento dashboard tab. Hand-written against window.__HERMES_PLUGIN_SDK__, so there's no build step.
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

  function MementoPage() {
    var state = useState(null)
    var status = state[0]
    var setStatus = state[1]
    var errorState = useState(null)
    var error = errorState[0]
    var setError = errorState[1]

    useEffect(function () {
      SDK.fetchJSON("/api/plugins/memento/status")
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
            h("code", null, "hermes plugins enable memento"),
            ", then ",
            h("code", null, "hermes gateway restart"),
            ".",
          ),
      )
    }

    return h(
      C.Card,
      null,
      h(C.CardHeader, null, h(C.CardTitle, null, "Memento")),
      h(C.CardContent, null, body),
    )
  }

  window.__HERMES_PLUGINS__.register("memento", MementoPage)
})()
