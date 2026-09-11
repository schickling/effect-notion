// Shell Entry (enterShell) dashboard
// How long do shell entry tasks take, with breakdown by task.
//
// Shell entry runs dependency bootstrap, generation, composition, and authoritative publication.
// These tasks are only executed when their dependencies change.
// Use FORCE_SETUP=1 to force re-run even when cached.
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';

// Helper for trace table (sorted by time, relative display)
local traceTable(title, query, limit=50) =
  g.panel.table.new(title)
  + g.panel.table.queryOptions.withTargets([
    lib.tempoQuery(query, 'A', limit),
  ])
  + g.panel.table.options.withSortBy([
    g.panel.table.options.sortBy.withDisplayName('startTime')
    + g.panel.table.options.sortBy.withDesc(true),
  ])
  + {
    fieldConfig+: {
      overrides: [
        {
          matcher: { id: 'byName', options: 'startTime' },
          properties: [{ id: 'unit', value: 'dateTimeFromNow' }],
        },
      ],
    },
  };

g.dashboard.new('Shell Entry Performance')
+ g.dashboard.withUid('otel-shell-entry')
+ g.dashboard.withDescription('Performance breakdown of dependency bootstrap, generation, composition, and authoritative editor publication')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.withPanels(
  g.util.grid.makeGrid([
    // Row: All shell entry tasks
    g.panel.row.new('Shell Entry Tasks'),

    traceTable(
      'All shell entry tasks',
      '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"buck2:editor:bootstrap|genie:run|mr:apply|buck2:editor:publish"}',
      50,
    ),

    // Row: Individual task breakdown
    g.panel.row.new('Task Breakdown'),

    traceTable(
      'buck2:editor:bootstrap',
      '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name="buck2:editor:bootstrap"}',
      30,
    ),

    traceTable(
      'genie:run',
      '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name="genie:run"}',
      30,
    ),

    traceTable(
      'mr:apply',
      '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name="mr:apply"}',
      30,
    ),

    traceTable(
      'buck2:editor:publish',
      '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name="buck2:editor:publish"}',
      30,
    ),
  ], panelWidth=24, panelHeight=10)
)
