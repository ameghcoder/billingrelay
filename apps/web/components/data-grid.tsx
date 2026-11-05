"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({ fontFamily: "inherit", browserColorScheme: "light", autoHeightMinBodyHeight: 0 });

const defaultColDef: ColDef = {
  sortable: true,
  resizable: true,
  wrapText: true,
  autoHeight: true,
  // Otherwise a boolean column becomes a checkbox and ignores its formatter.
  cellDataType: false,
  // Cells inherit the row's height as line height, which spaces wrapped text far apart.
  cellStyle: { lineHeight: "1.4", paddingBlock: "10px" },
};

export function DataGrid<Row>({
  label,
  rows,
  columns,
  rowId,
}: {
  label: string;
  rows: Row[];
  columns: ColDef<Row>[];
  rowId: (row: Row) => string;
}) {
  return (
    <div role="region" aria-label={label}>
      <AgGridReact<Row>
        theme={theme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={({ data }) => rowId(data)}
        domLayout="autoHeight"
        enableCellTextSelection
        suppressCellFocus
      />
    </div>
  );
}
