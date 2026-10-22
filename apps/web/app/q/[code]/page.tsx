import PublicIntake from '../../public-intake';
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <PublicIntake code={code} />;
}
