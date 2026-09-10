import React from 'react'
import type { FC } from 'react'

import { useStyles } from '../styles/index.tsx'
import { TH } from './TH.tsx'

const EMPTY_COLUMNS: string[] = []

export const HeaderContainer: FC<{
  indexColumnText?: string
  columns?: string[]
  sorted: boolean
  sortIndexColumn: boolean
  sortColumn: string | undefined
  sortAscending: boolean
  onTHClick: (col: string) => void
  onIndexTHClick: () => void
}> = ({
  indexColumnText = '(index)',
  columns = EMPTY_COLUMNS,
  sorted,
  sortIndexColumn,
  sortColumn,
  sortAscending,
  onTHClick,
  onIndexTHClick,
}) => {
  const styles = useStyles('TableInspectorHeaderContainer')
  const borderStyles = useStyles('TableInspectorLeftBorder')
  return (
    <div style={styles.base}>
      <table style={styles.table}>
        <tbody>
          <tr>
            <TH
              borderStyle={borderStyles.none}
              sorted={sorted && sortIndexColumn}
              sortAscending={sortAscending}
              onClick={onIndexTHClick}
            >
              {indexColumnText}
            </TH>
            {columns.map((column) => (
              <TH
                borderStyle={borderStyles.solid}
                key={column}
                sorted={sorted && sortColumn === column}
                sortAscending={sortAscending}
                onClick={onTHClick.bind(null, column)}
              >
                {column}
              </TH>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
