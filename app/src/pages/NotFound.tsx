const NotFound = () => {
  return (
    <main className="min-h-screen bg-[#efe7d5] text-[#171613]">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16">
        <h1 className="text-3xl font-semibold">Not found</h1>
        <p className="text-[#3a362f]">This room does not exist.</p>
        <a className="text-sm underline" href="/">
          Back to landing
        </a>
      </div>
    </main>
  );
};

export default NotFound;
