import { useEffect } from 'react';
import ToolNavigation from '@/components/ToolNavigation';
import SpreadsheetConverter from '@/features/spreadsheet-to-sql/components/SpreadsheetConverter';

export default function SpreadsheetToSqlPage() {
    useEffect(() => { document.title = 'Spreadsheet to SQL — ERD Go'; }, []);
    return <div className="spreadsheet-page"><ToolNavigation /><SpreadsheetConverter /></div>;
}
