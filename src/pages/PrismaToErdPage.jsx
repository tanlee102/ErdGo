import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import PrismaToErdTool from '@/features/prisma-erd/components/PrismaToErdTool';

export default function PrismaToErdPage() {
    const { index } = useParams();
    useEffect(() => { document.title = 'Prisma to ERD — ERD Go'; }, []);
    return <PrismaToErdTool index={index} />;
}
